import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { TicketTracker } from "../ports/index.js"
import type { Ticket } from "../types.js"
import type { Logger } from "../util/log.js"

/**
 * Local read-model of the tracker. The cockpit (and any other read-heavy
 * surface) serves from this mirror; the tracker is consulted only by bounded
 * refreshes — never per request. Writes stay immediate and go straight
 * through the port (they *are* the meaningful changes); the mirror is marked
 * dirty so the next read pulls a fresh sweep.
 *
 * Durability: the mirror persists to disk, so a restarted serve paints the
 * last known board instantly instead of re-spending tracker quota on boot.
 *
 * Refresh policy (all bounds in code, never in an LLM's judgement):
 * - reads answer instantly from local state — stale-while-revalidate, never
 *   blocking on the tracker
 * - a sweep runs in the background when data is older than `maxAgeMs`
 * - rebuild at most once per `minSpacingMs`; rebuilds are single-flight
 * - after a failed sweep, back off exponentially; a tracker-declared
 *   `retryAfter` is honored (capped) — a throttled tracker is a closed gate,
 *   not an invitation
 */

/** Next backoff for the Nth consecutive failure (1-based), exponential with a ceiling. */
export function nextBackoffMs(failures: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(0, failures - 1), capMs)
}

/** Pull a tracker-declared retry hint out of an error message, in ms. */
export function parseRetryAfterMs(message: string): number | undefined {
  const m = message.match(/retry(?:\s+after)?[:\s]+(\d+)\s*(?:seconds|s)\b/i)
  return m ? Number(m[1]) * 1000 : undefined
}

/** Logical states the sweep covers — the same set the cockpit graphs. */
const SWEEP_STATES = ["backlog", "selected", "inProgress", "inReview", "done"] as const

export interface TrackerMirrorOptions {
  /** Serve local data without a sweep while younger than this. Default 60s. */
  maxAgeMs?: number
  /** Two sweeps never start closer together than this. Default 5s. */
  minSpacingMs?: number
  /** First backoff step after a failed sweep. Default 15s. */
  backoffBaseMs?: number
  /** Backoff ceiling (a tracker may declare hours; we still retry eventually). Default 1h. */
  backoffCapMs?: number
  /** Injectable clock (tests). */
  now?: () => number
}

interface MirrorFile {
  fetchedAt: string
  tickets: Ticket[]
}

export class TrackerMirror {
  private ticketsCache: Ticket[] = []
  private fetchedAt = 0
  private dirty = true // nothing loaded yet
  private failures = 0
  private lastError?: string
  private rebuildNotBefore = 0
  private lastSweepAt = 0
  private inflight?: Promise<void>

  constructor(
    private readonly tracker: TicketTracker,
    private readonly filePath: string,
    private readonly log: Logger,
    private readonly opts: TrackerMirrorOptions = {},
    private readonly scope: { project?: string } = {},
  ) {
    this.load()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private maxAge(): number {
    return this.opts.maxAgeMs ?? 60_000
  }

  private minSpacing(): number {
    return this.opts.minSpacingMs ?? 5_000
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as MirrorFile
      if (!Array.isArray(raw.tickets)) return
      this.ticketsCache = raw.tickets
      this.fetchedAt = Date.parse(raw.fetchedAt ?? "") || 0
      this.dirty = false
    } catch (err) {
      this.log.debug(`mirror: could not load ${this.filePath} — ${(err as Error).message}`)
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true })
      const file: MirrorFile = { fetchedAt: new Date(this.fetchedAt).toISOString(), tickets: this.ticketsCache }
      writeFileSync(this.filePath, JSON.stringify(file))
    } catch (err) {
      this.log.debug(`mirror: could not save ${this.filePath} — ${(err as Error).message}`)
    }
  }

  /**
   * Local tickets, answered immediately from local state
   * (stale-while-revalidate). When data is stale or absent, a bounded sweep
   * runs in the background; the next read — or SSE push — picks it up.
   * `force` awaits the sweep instead of racing it, but never bypasses
   * tracker backoff: a throttled tracker is a closed gate. Never throws —
   * sweep failures surface via degraded().
   */
  async tickets(force = false): Promise<Ticket[]> {
    const t = this.now()
    const stale = this.dirty || t - this.fetchedAt > this.maxAge()
    if (!this.inflight && (force || stale) && t >= this.rebuildNotBefore && t - this.lastSweepAt >= this.minSpacing()) {
      const sweep = this.sweep()
      this.inflight = sweep.finally(() => {
        this.inflight = undefined
      })
    }
    if (force && this.inflight) await this.inflight
    return this.ticketsCache
  }

  /** Why local data may be out of date, for surfacing in the cockpit. */
  degraded(): string | undefined {
    if (this.failures > 0 && this.lastError) return this.lastError
    if (this.fetchedAt === 0) return "waiting for first tracker sync…"
    return undefined
  }

  /** A write went through the port — next read should reconcile. */
  noteLocalChange(): void {
    this.dirty = true
  }

  /** Background-friendly: sweep only if due. Never throws. */
  async refreshIfDue(): Promise<void> {
    const t = this.now()
    const stale = this.dirty || t - this.fetchedAt > this.maxAge()
    if (!stale || t < this.rebuildNotBefore || t - this.lastSweepAt < this.minSpacing()) return
    try {
      await this.tickets(true)
    } catch {
      /* surfaced via degraded(); background refresh must not crash the server */
    }
  }

  private async sweep(): Promise<void> {
    try {
      const byKey = new Map<string, Ticket>()
      for (const state of SWEEP_STATES) {
        for (const brief of await this.tracker.listIssues({ ...this.scope, state })) {
          if (!byKey.has(brief.key)) byKey.set(brief.key, brief)
        }
      }
      const full: Ticket[] = []
      for (const [key, brief] of byKey) {
        try {
          full.push(await this.tracker.getTicket(key))
        } catch {
          full.push(brief)
        }
      }
      this.ticketsCache = full
      this.fetchedAt = this.now()
      this.dirty = false
      this.failures = 0
      this.lastError = undefined
      this.rebuildNotBefore = 0
      this.lastSweepAt = this.fetchedAt
      this.save()
    } catch (err) {
      const message = (err as Error).message
      this.failures++
      this.lastError = message
      const declared = parseRetryAfterMs(message)
      const wait = declared !== undefined ? Math.min(declared, this.opts.backoffCapMs ?? 60 * 60_000) : nextBackoffMs(this.failures, this.opts.backoffBaseMs ?? 15_000, this.opts.backoffCapMs ?? 60 * 60_000)
      this.rebuildNotBefore = this.now() + wait
      this.log.warn(`mirror: sweep failed (${this.failures}) — backing off ${Math.round(wait / 1000)}s: ${message}`)
    }
  }
}
