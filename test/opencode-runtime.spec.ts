import { describe, expect, it } from "vitest"
import { lastAssistantText, ModelCallFailedError } from "../src/adapters/runtime-opencode/index.js"

/**
 * Regression tests pinned to the REAL V2 API shapes observed on a live server
 * (2026-09): context returns a {data:[...]} envelope; messages use
 * `type: "assistant"` and `content: [{type: "reasoning"|"text", text}]`.
 */
describe("lastAssistantText against live API shapes", () => {
  const liveContext = {
    data: [
      { id: "msg_1", time: { created: 1 }, type: "agent-switched", agent: "sdlc-split" },
      {
        id: "msg_2",
        time: { created: 2 },
        text: "Define the deterministic acceptance check…",
        type: "user",
      },
      {
        id: "msg_3",
        time: { created: 3, streamed: 4, completed: 5 },
        type: "assistant",
        agent: "sdlc-split",
        model: { id: "gpt-5.6-sol", providerID: "openai" },
        content: [
          { type: "reasoning", text: "Now I have a good understanding of the project…" },
          { type: "text", text: '```json\n{"acceptanceTest":"…","testPath":"test/store.test.js","brief":"…"}\n```' },
        ],
      },
    ],
  }

  it("extracts the text part through the data envelope, skipping reasoning", () => {
    const out = lastAssistantText(liveContext)
    expect(out).toContain('"acceptanceTest"')
    expect(out).not.toContain("good understanding")
  })

  it("treats an error-carrying assistant message as terminal", () => {
    const errored = {
      data: [
        { type: "assistant", content: [] as unknown[], error: { type: "provider.transport", message: "ECONNRESET" } },
      ],
    }
    expect(() => lastAssistantText(errored)).toThrow(ModelCallFailedError)
    expect(() => lastAssistantText(errored)).toThrow(/ECONNRESET/)
  })

  it("throws the retryable no-message error when nothing is there yet", () => {
    expect(() => lastAssistantText({ data: [] })).toThrow(/no assistant message/)
    expect(() => lastAssistantText([])).toThrow(/no assistant message/)
  })

  it("still tolerates legacy role/parts shapes", () => {
    expect(
      lastAssistantText([{ role: "assistant", parts: [{ type: "text", text: "legacy ok" }] }]),
    ).toBe("legacy ok")
  })
})
