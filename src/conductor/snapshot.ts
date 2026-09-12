import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import type { ResolvedConfig } from "../config.js"
import { selectorFor } from "../config.js"
import type { LedgerStore, TicketTracker } from "../ports/index.js"
import type { Logger } from "../util/log.js"
import type { RunState } from "../types.js"
import { classifyCandidate } from "./tick.js"
import type { ConductorDeps } from "./deps.js"
import type { TrackerMirror } from "./tracker-mirror.js"
import { readRunEvents, type RunEvent } from "./run-events.js"

/**
 * One read-only snapshot of the whole SDLC process, assembled from the same
 * sources of truth the conductor uses: the tracker (backlog + graph), run
 * state files (deliveries), the ledger (budget), and the OpenCode background
 * service (live agent sessions). This is what `sdlc serve` streams to the
 * cockpit — and the CLI can print it just as well.
 */

export interface CockpitSnapshot {
  ts: string
  /** Set when the tracker mirror is serving stale data (last sweep failed). */
  degraded?: string
  project: {
    repoRoot: string
    team: string
    adapters: string
    dryRun: boolean
    budget: { perTaskUsd: number; perTaskTokens: number; maxParallelDeliveries: number }
  }
  counts: Record<string, number>
  tickets: Array<{
    key: string
    title: string
    state: string
    labels: string[]
    selected: boolean
    ready: boolean
    blockedBy: string[]
    needsInfo: boolean
    reason?: string
    relations: { kind: string; key: string; state: string }[]
  }>
  runs: Array<RunState & { title?: string }>
  live: {
    serviceUp: boolean
    sessions: Array<{
      id: string
      ticket: string
      role: string
      running: boolean
      model?: string
      tokens: { input: number; output: number }
      updatedTs: number
      outcome?: string
    }>
  }
  budget: {
    byTicket: { key: string; tokens: number; costUsd: number; calls: number }[]
    byPhase: { key: string; tokens: number; costUsd: number; calls: number }[]
    total: { tokens: number; costUsd: number }
  }
  activity: { ts: string; text: string }[]
  /** Bounded local execution timeline; no prompts or model output. */
  events: RunEvent[]
}

export interface SnapshotDeps {
  config: ResolvedConfig
  tracker: TicketTracker
  ledger: LedgerStore
  log: Logger
}

/** Minimal structural surface of the generated client we use. */
export interface OpencodeClient {
  "session.list"(): Promise<unknown>
  "session.active"(): Promise<unknown>
  "session.interrupt"(input: { sessionID: string; continue: boolean }): Promise<unknown>
}

export async function buildSnapshot(deps: SnapshotDeps, mirror: TrackerMirror): Promise<CockpitSnapshot> {
  const { config, ledger, log } = deps
  const selectedName = selectorFor(config, "selected").name
  const needsInfoName = selectorFor(config, "needsInfo").name

  // --- backlog + dependency graph (from the local mirror — zero tracker calls) ---
  const deduped = [...new Map((await mirror.tickets()).map((t) => [t.key, t])).values()]
  const tickets: CockpitSnapshot["tickets"] = deduped.map((t) => {
    const needsInfo = t.labels.includes(needsInfoName)
    const blockedBy = t.relations
      .filter((r) => r.kind === "blocked-by" && r.state !== "done" && r.state !== "cancelled")
      .map((r) => r.key)
    const reason = needsInfo
      ? "needs-info"
      : blockedBy.length
        ? `blocked by ${blockedBy[0] ?? ""}`
        : classifyCandidate({ config } as ConductorDeps, t)
    return {
      key: t.key,
      title: t.title,
      state: t.state,
      labels: t.labels,
      selected: t.labels.includes(selectedName),
      ready: reason === undefined,
      blockedBy,
      needsInfo,
      reason,
      relations: t.relations.map((r) => ({ kind: r.kind, key: r.key, state: r.state })),
    }
  })

  const counts: Record<string, number> = {
    backlog: 0,
    selected: 0,
    inProgress: 0,
    inReview: 0,
    done: 0,
    needsInfo: 0,
    readyNow: 0,
    blocked: 0,
  }
  for (const t of tickets) {
    counts[t.state] = (counts[t.state] ?? 0) + 1
    if (t.needsInfo) counts["needsInfo"]! += 1
    if (t.ready) counts["readyNow"]! += 1
    if (t.blockedBy.length) counts["blocked"]! += 1
  }

  // --- run states ------------------------------------------------------------
  const titleOf = new Map(tickets.map((t) => [t.key, t.title]))
  const runs: CockpitSnapshot["runs"] = []
  if (existsSync(config.artifactsDir)) {
    for (const key of readdirSync(config.artifactsDir)) {
      const stateFile = path.join(config.artifactsDir, key, "state.json")
      if (!existsSync(stateFile)) continue
      try {
        const run = JSON.parse(readFileSync(stateFile, "utf8")) as RunState
        runs.push({ ...run, title: titleOf.get(run.ticket) })
      } catch {
        /* partially written state — skip */
      }
    }
  }
  runs.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))

  // --- detailed execution timeline (local JSONL, no tracker calls) ------------
  const events: RunEvent[] = []
  if (existsSync(config.artifactsDir)) {
    for (const key of readdirSync(config.artifactsDir)) {
      events.push(...readRunEvents(path.join(config.artifactsDir, key, "events.jsonl"), 120))
    }
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts))
  if (events.length > 300) events.splice(0, events.length - 300)

  // --- budget ----------------------------------------------------------------
  const byTicket = await ledger.rollup("ticket")
  const byPhase = await ledger.rollup("phase")
  const total = {
    tokens: byTicket.reduce((s, r) => s + r.tokens, 0),
    costUsd: byTicket.reduce((s, r) => s + r.costUsd, 0),
  }

  // --- live agent sessions (OpenCode background service) ---------------------
  const live = await readLiveSessions(config)

  // --- activity feed -----------------------------------------------------------
  const activity = buildActivity(runs, byTicket)

  log.debug(`snapshot: ${tickets.length} tickets, ${runs.length} runs, ${live.sessions.length} agent sessions`)
  return {
    ts: new Date().toISOString(),
    degraded: mirror.degraded(),
    project: {
      repoRoot: config.repoRoot,
      team: config.raw.tracker.team,
      adapters: `${config.raw.adapters.tracker}/${config.raw.adapters.codehost}/${config.raw.adapters.preview}/${config.raw.adapters.runtime}`,
      dryRun: config.raw.dryRun,
      budget: {
        perTaskUsd: config.raw.budget.perTaskUsd,
        perTaskTokens: config.raw.budget.perTaskTokens,
        maxParallelDeliveries: config.raw.budget.maxParallelDeliveries,
      },
    },
    counts,
    tickets,
    runs,
    live,
    budget: {
      byTicket: byTicket.map((r) => ({ key: r.key, tokens: r.tokens, costUsd: r.costUsd, calls: r.runs })),
      byPhase: byPhase.map((r) => ({ key: r.key, tokens: r.tokens, costUsd: r.costUsd, calls: r.runs })),
      total,
    },
    activity,
    events,
  }
}

async function readLiveSessions(config: ResolvedConfig): Promise<CockpitSnapshot["live"]> {
  try {
    const [{ OpenCode }, { Service }] = (await Promise.all([
      import("@opencode/client"),
      import("@opencode/client/service"),
    ])) as unknown as [
      { OpenCode: { make(o: { baseUrl: string; headers?: Record<string, string> }): OpencodeClient } },
      { Service: { discover(): Promise<{ url: string } | undefined>; headers(e: { url: string }): Record<string, string> | undefined } },
    ]
    const endpoint = await Service.discover()
    if (!endpoint) return { serviceUp: false, sessions: [] }
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const listRaw = (await client["session.list"]()) as { data?: unknown[] } | unknown[]
    const sessions = (Array.isArray(listRaw) ? listRaw : (listRaw?.data ?? [])) as Array<Record<string, any>>
    const activeRaw = (await client["session.active"]()) as { data?: Record<string, unknown> } | Record<string, unknown>
    const active = (activeRaw && !Array.isArray(activeRaw) ? (activeRaw.data ?? activeRaw) : {}) as Record<string, unknown>

    const out: CockpitSnapshot["live"]["sessions"] = []
    for (const s of sessions) {
      const title = String(s.title ?? "")
      if (!title.startsWith("sdlc:")) continue
      const loc = String(s.location?.directory ?? "")
      if (!loc.startsWith(config.repoRoot)) continue
      const parts = title.split(":") // sdlc:KEY:role
      out.push({
        id: String(s.id ?? ""),
        ticket: parts[1] ?? "?",
        role: parts[2] ?? "?",
        running: Boolean(active[s.id as string]),
        model: s.model ? `${s.model.providerID}/${s.model.id}` : undefined,
        tokens: { input: Number(s.tokens?.input ?? 0), output: Number(s.tokens?.output ?? 0) },
        updatedTs: Number(s.time?.updated ?? 0),
        outcome: s.outcome ? String(s.outcome) : undefined,
      })
    }
    // running first, then most recently updated; drop anything older than 12h
    const cutoff = Date.now() - 12 * 3600_000
    return {
      serviceUp: true,
      sessions: out
        .filter((s) => s.running || s.updatedTs >= cutoff)
        .sort((a, b) => Number(b.running) - Number(a.running) || b.updatedTs - a.updatedTs)
        .slice(0, 30),
    }
  } catch {
    return { serviceUp: false, sessions: [] }
  }
}

function buildActivity(runs: CockpitSnapshot["runs"], byTicket: { key: string; runs: number }[]): CockpitSnapshot["activity"] {
  const events: { ts: string; text: string; sort: string }[] = []
  for (const r of runs.slice(0, 12)) {
    events.push({
      ts: (r.updatedAt ?? "").slice(11, 19),
      text: `${r.ticket} ${r.status === "delivered" ? "✔ delivered" : r.status === "escalated" ? "? escalated" : r.status === "parked" ? "⏸ parked" : r.status === "dry-run" ? "◌ dry run" : "✕ failed"} at ${r.phaseReached}`,
      sort: r.updatedAt ?? "",
    })
  }
  for (const t of byTicket.slice(0, 8)) {
    events.push({ ts: "", text: `ledger ${t.key}: ${t.runs} calls`, sort: "0" })
  }
  return events.sort((a, b) => b.sort.localeCompare(a.sort)).slice(0, 14).map(({ ts, text }) => ({ ts, text }))
}
