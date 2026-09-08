import type { AgentRole, LedgerEntry, PhaseName } from "../../types.js"

/**
 * Real server event shapes, verified against a live opencode v1.1.x service
 * (`session.usage.updated` / `session.step.ended`):
 *
 * ```json
 * { "type": "session.usage.updated",
 *   "data": { "sessionID": "ses_…", "cost": 0,
 *             "tokens": { "input": 7408, "output": 6, "reasoning": 16,
 *                         "cache": { "read": 1344, "write": 0 } } } }
 * ```
 *
 * If a server upgrade changes this shape, capture fresh payloads with
 * `SDL_LIVE_SMOKE=1` runs or `test/runtime-live.spec.ts` and extend the
 * fixtures in `test/runtime-usage.spec.ts` — never debug through full ticks.
 */

export interface UsageEventView {
  sessionID: string
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number | null
}

/** Tolerant reader: returns undefined for events that carry no usable usage. */
export function readUsageEvent(raw: unknown): UsageEventView | undefined {
  const ev = raw as Record<string, any>
  if (!ev || typeof ev !== "object") return undefined
  if (ev.type !== "session.usage.updated") return undefined
  const data = ev.data
  if (!data || typeof data !== "object") return undefined
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
  const tokens = data.tokens
  if (!sessionID || !tokens || typeof tokens !== "object") return undefined
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {}
  const cost = typeof data.cost === "number" && Number.isFinite(data.cost) ? data.cost : null
  return {
    sessionID,
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
    cost,
  }
}

/** LLM phase name for an agent role — phases and their primary agents map 1:1. */
export const ROLE_PHASE: Record<AgentRole, PhaseName> = {
  groomer: "groom",
  split: "split",
  researcher: "research",
  council: "council",
  executor: "execute",
  reviewer: "review",
  tester: "test",
}

export interface UsageRunContext {
  runId: string
  ticket: string
  /** Concrete model id configured for the role (provider/id), if any. */
  modelFor(role: AgentRole): string | undefined
}

/**
 * Map one server event to a ledger entry. Strict ownership: only sessions
 * this run created are attributed — the event stream is server-global, and
 * foreign sessions (the user's own opencode work) must never pollute the
 * ledger. Reasoning tokens are billed as generated output, so they fold into
 * `output` for budget and rollup purposes.
 */
export function usageEntryFromEvent(
  raw: unknown,
  ownedSessions: ReadonlyMap<string, AgentRole>,
  ctx: UsageRunContext,
): LedgerEntry | undefined {
  const usage = readUsageEvent(raw)
  if (!usage) return undefined
  const role = ownedSessions.get(usage.sessionID)
  if (!role) return undefined
  return {
    runId: ctx.runId,
    ticket: ctx.ticket,
    phase: ROLE_PHASE[role],
    agent: role,
    model: ctx.modelFor(role),
    ts: new Date().toISOString(),
    tokens: {
      input: usage.input,
      output: usage.output + usage.reasoning,
      cacheRead: usage.cacheRead || undefined,
      cacheWrite: usage.cacheWrite || undefined,
    },
    costUsd: usage.cost,
    sessionId: usage.sessionID,
  }
}
