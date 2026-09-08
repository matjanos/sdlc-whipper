import { describe, expect, it, vi } from "vitest"
import { ActivityTracker } from "../src/adapters/runtime-opencode/activity.js"

/**
 * Fixtures from a live tool-using agent run (scratch probe, 2026-09-08) —
 * a real GLM flash session that called shell tools.
 */
const OWNED_ROLE = "executor" as const
const owned = new Map([["ses_owned", OWNED_ROLE]])

function tracker(onActivity = vi.fn()): ReturnType<typeof vi.fn> & { tracker: ActivityTracker } {
  const spy = vi.fn()
  const t = new ActivityTracker({ owned: (sid) => owned.get(sid), onActivity: spy })
  ;(t as unknown as { spy: unknown }).spy = spy
  return Object.assign(spy.bind(null), { tracker: t, spy }) as never
}

const TOOL_STARTED = {
  type: "session.tool.input.started",
  data: { sessionID: "ses_owned", assistantMessageID: "msg_1", id: "call_1", name: "read" },
}
const TOOL_CALLED = {
  type: "session.tool.called",
  data: {
    sessionID: "ses_owned",
    id: "call_2",
    input: { command: "gh run watch --repo matjanos/sdlc-whipper --exit-status", timeout: 180000 },
  },
}
const THINKING = { type: "session.reasoning.started", data: { sessionID: "ses_owned" } }
const USAGE = {
  type: "session.usage.updated",
  data: { sessionID: "ses_owned", cost: 0, tokens: { input: 7408, output: 6, reasoning: 16, cache: { read: 1344 } } },
}

describe("ActivityTracker (deterministic loader text from real events)", () => {
  it("announces tool calls with their name and argument detail", () => {
    const onActivity = vi.fn()
    const t = new ActivityTracker({ owned: (sid) => owned.get(sid), onActivity })
    t.observe(TOOL_STARTED)
    expect(onActivity).toHaveBeenLastCalledWith({ role: OWNED_ROLE, text: "read", tokens: 0 })
    t.observe(TOOL_CALLED)
    expect(onActivity).toHaveBeenLastCalledWith({
      role: OWNED_ROLE,
      text: "gh run watch --repo matjanos/sdlc-whipper --exit…",
      tokens: 0,
    })
  })

  it("tracks thinking/composing phases and cumulative token burn", () => {
    const onActivity = vi.fn()
    const t = new ActivityTracker({ owned: (sid) => owned.get(sid), onActivity })
    t.observe(THINKING)
    expect(onActivity).toHaveBeenLastCalledWith({ role: OWNED_ROLE, text: "thinking", tokens: 0 })
    t.observe(USAGE)
    expect(onActivity).toHaveBeenLastCalledWith({ role: OWNED_ROLE, text: "thinking", tokens: 8774 })
  })

  it("never emits for foreign sessions on the server-global stream", () => {
    const onActivity = vi.fn()
    const t = new ActivityTracker({ owned: (sid) => owned.get(sid), onActivity })
    t.observe({ type: "session.tool.input.started", data: { sessionID: "ses_foreign", name: "bash" } })
    t.observe({ type: "session.usage.updated", data: { sessionID: "ses_foreign", tokens: { input: 9 } } })
    expect(onActivity).not.toHaveBeenCalled()
  })

  it("throttles: identical state does not re-emit", () => {
    const onActivity = vi.fn()
    const t = new ActivityTracker({ owned: (sid) => owned.get(sid), onActivity })
    t.observe(TOOL_STARTED)
    const calls = onActivity.mock.calls.length
    t.observe({ ...TOOL_STARTED }) // same tool again, no new info
    expect(onActivity.mock.calls.length).toBe(calls)
  })
})
