import { describe, expect, it } from "vitest"
import { readUsageEvent, UsageDeltaTracker, usageEntryFromEvent } from "../src/adapters/runtime-opencode/usage.js"

/**
 * Fixtures captured from a live opencode v1.1.x service (scratch probe,
 * 2026-09-08). If a server upgrade changes the wire shape, re-capture and
 * extend here — never debug usage attribution through full paid tick runs.
 */
const REAL_USAGE_EVENT = {
  id: "evt_080ff8352001m334HCxA5YVl2N",
  created: 1788870624082,
  type: "session.usage.updated",
  data: {
    sessionID: "ses_f7f00a8a1ffegYDI44vU6dbNER",
    cost: 0,
    tokens: {
      input: 7408,
      output: 6,
      reasoning: 16,
      cache: { read: 1344, write: 0 },
    },
  },
}

const OWNED = new Map([["ses_f7f00a8a1ffegYDI44vU6dbNER", "reviewer" as const]])
const CTX = {
  runId: "run_LAW-1_x",
  ticket: "LAW-1",
  modelFor: (role: string) => (role === "reviewer" ? "zai-coding-plan/glm-5.3" : undefined),
}

describe("readUsageEvent (tolerant shape reader)", () => {
  it("reads the verified live event shape", () => {
    const view = readUsageEvent(REAL_USAGE_EVENT)
    expect(view).toMatchObject({
      sessionID: "ses_f7f00a8a1ffegYDI44vU6dbNER",
      input: 7408,
      output: 6,
      reasoning: 16,
      cacheRead: 1344,
      cacheWrite: 0,
      cost: 0,
    })
  })

  it("ignores unrelated events and malformed payloads instead of throwing", () => {
    expect(readUsageEvent({ type: "session.step.started" })).toBeUndefined()
    expect(readUsageEvent({ type: "session.usage.updated" })).toBeUndefined()
    expect(readUsageEvent({ type: "session.usage.updated", data: { sessionID: "ses_x" } })).toBeUndefined()
    expect(readUsageEvent("garbage")).toBeUndefined()
  })
})

describe("usageEntryFromEvent (strict attribution)", () => {
  it("attributes owned sessions to their role, phase, and configured model", () => {
    const entry = usageEntryFromEvent(REAL_USAGE_EVENT, OWNED, CTX)
    expect(entry).toBeDefined()
    expect(entry!.agent).toBe("reviewer")
    expect(entry!.phase).toBe("review")
    expect(entry!.ticket).toBe("LAW-1")
    expect(entry!.model).toBe("zai-coding-plan/glm-5.3")
    expect(entry!.tokens.input).toBe(7408)
    expect(entry!.tokens.output).toBe(22) // output + reasoning
    expect(entry!.tokens.cacheRead).toBe(1344)
    expect(entry!.costUsd).toBe(0) // plan subscription → server reports 0
    expect(entry!.sessionId).toBe("ses_f7f00a8a1ffegYDI44vU6dbNER")
  })

  it("never attributes foreign sessions (server-global stream)", () => {
    const foreign = new Map([["ses_mine", "executor" as const]])
    expect(usageEntryFromEvent(REAL_USAGE_EVENT, foreign, CTX)).toBeUndefined()
  })

  it("maps each role to its delivery phase", () => {
    const executorEvent = structuredClone(REAL_USAGE_EVENT) as typeof REAL_USAGE_EVENT
    executorEvent.data.sessionID = "ses_exec"
    const entry = usageEntryFromEvent(executorEvent, new Map([["ses_exec", "executor" as const]]), CTX)
    expect(entry!.phase).toBe("execute")
  })

  it("keeps null cost when the server omits it", () => {
    const noCost = structuredClone(REAL_USAGE_EVENT) as typeof REAL_USAGE_EVENT
    delete (noCost.data as Record<string, unknown>).cost
    const entry = usageEntryFromEvent(noCost, OWNED, CTX)
    expect(entry!.costUsd).toBeNull()
  })
})

/**
 * Real servers report `session.usage.updated` as absolute session-lifetime
 * totals (upstream #35781). Ledgering each event whole re-adds the entire
 * session spend per event — the budget guard then reads multiples of its cap.
 * The tracker turns snapshots into deltas; the ledger must sum to true spend.
 */
describe("UsageDeltaTracker (cumulative snapshots → ledger deltas)", () => {
  const SES = "ses_delta"
  const OWNED_SES = new Map([
    [SES, "executor" as const],
    ["ses_a", "executor" as const],
    ["ses_b", "reviewer" as const],
  ])

  const snapshot = (total: number, sessionID = SES, cost: number | null = 0): unknown => ({
    type: "session.usage.updated",
    data: {
      sessionID,
      cost,
      tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  })

  const deltasOf = (events: unknown[], tracker = new UsageDeltaTracker()): (ReturnType<typeof usageEntryFromEvent>)[] =>
    events.map((raw) => usageEntryFromEvent(raw, OWNED_SES, CTX, tracker))

  const tokensOf = (entry: ReturnType<typeof usageEntryFromEvent>): number =>
    entry ? entry.tokens.input + entry.tokens.output + (entry.tokens.cacheRead ?? 0) + (entry.tokens.cacheWrite ?? 0) : 0

  it("ledgers growing cumulative snapshots as deltas — Σ deltas equals the final total", () => {
    const entries = deltasOf([snapshot(400_000), snapshot(800_000), snapshot(1_200_000)])
    expect(entries.map((e) => tokensOf(e))).toEqual([400_000, 400_000, 400_000])
    const total = entries.reduce((sum, e) => sum + tokensOf(e), 0)
    expect(total).toBe(1_200_000)
    expect(total).toBeLessThan(400_000 + 800_000 + 1_200_000) // never the snapshot sum
  })

  it("repeats of the same snapshot produce no ledger entry", () => {
    const entries = deltasOf([snapshot(500), snapshot(500), snapshot(500)])
    expect(entries).toEqual([expect.anything(), undefined, undefined])
    expect(tokensOf(entries[0])).toBe(500)
  })

  it("clamps counter regressions to zero instead of inventing negative spend", () => {
    const entries = deltasOf([snapshot(1_000), snapshot(400)])
    expect(entries[1]).toBeUndefined()
  })

  it("tracks sessions independently (interleaved role sessions share one tracker)", () => {
    const tracker = new UsageDeltaTracker()
    const entries = [
      usageEntryFromEvent(snapshot(100, "ses_a"), OWNED_SES, CTX, tracker),
      usageEntryFromEvent(snapshot(50, "ses_b"), OWNED_SES, CTX, tracker),
      usageEntryFromEvent(snapshot(300, "ses_a"), OWNED_SES, CTX, tracker),
      usageEntryFromEvent(snapshot(80, "ses_b"), OWNED_SES, CTX, tracker),
    ]
    expect(entries.map(tokensOf)).toEqual([100, 50, 200, 30])
  })

  it("deltas cumulative cost and keeps null cost null", () => {
    const tracker = new UsageDeltaTracker()
    const [first, second, third] = deltasOf(
      [snapshot(100, SES, 0.1), snapshot(200, SES, 0.3), snapshot(300, SES, null)],
      tracker,
    )
    expect(first!.costUsd).toBe(0.1)
    expect(second!.costUsd).toBeCloseTo(0.2, 10)
    expect(third!.costUsd).toBeNull()
  })

  it("deltas each bucket — reasoning folds into output per entry", () => {
    const tracker = new UsageDeltaTracker()
    const grow = (input: number, output: number, reasoning: number, read: number): unknown => ({
      type: "session.usage.updated",
      data: { sessionID: SES, cost: 0, tokens: { input, output, reasoning, cache: { read } } },
    })
    const [first, second] = deltasOf([grow(100, 10, 5, 40), grow(160, 15, 9, 1040)], tracker)
    expect(first!.tokens).toEqual({ input: 100, output: 15, cacheRead: 40 })
    expect(second!.tokens).toEqual({ input: 60, output: 5 + 4, cacheRead: 1000 })
  })
})
