import { describe, expect, it } from "vitest"
import { readUsageEvent, usageEntryFromEvent } from "../src/adapters/runtime-opencode/usage.js"

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
