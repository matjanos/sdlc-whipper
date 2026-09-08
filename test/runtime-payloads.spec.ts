import { describe, expect, it } from "vitest"
import { ModelCallFailedError, lastAssistantText } from "../src/adapters/runtime-opencode/index.js"

/**
 * Message-shape fixtures for the OpenCode runtime's assistant extraction.
 * Shapes are reconstructed from the live server (v1.1.x) — when a server
 * upgrade changes the wire shape, extend these fixtures from
 * `SDL_LIVE_SMOKE=1 pnpm test` captures instead of debugging through a full
 * paid tick run.
 */

const V2_DOCUMENTED = [
  { type: "user", content: [{ type: "text", text: "review this" }] },
  {
    type: "assistant",
    content: [
      { type: "reasoning", text: "thinking…" },
      { type: "text", text: "looks good\napprove" },
    ],
  },
]

const ROLE_PARTS = [
  { role: "user", parts: [{ type: "text", text: "go" }] },
  { role: "assistant", parts: [{ type: "text", text: "verdict prose" }] },
]

const PROSE_NO_JSON =
  "The change is correct against every acceptance criterion and well tested. Approve."

describe("lastAssistantText (defensive extraction)", () => {
  it("extracts the last assistant text from the documented V2 shape", () => {
    expect(lastAssistantText(V2_DOCUMENTED)).toBe("looks good\napprove")
  })

  it("unwraps {data: [...]} envelopes", () => {
    expect(lastAssistantText({ data: V2_DOCUMENTED })).toBe("looks good\napprove")
  })

  it("tolerates role/parts shapes", () => {
    expect(lastAssistantText(ROLE_PARTS)).toBe("verdict prose")
  })

  it("returns prose even when it contains no verdict block (verdict parse is a later, separate failure)", () => {
    expect(lastAssistantText([{ type: "assistant", content: [{ type: "text", text: PROSE_NO_JSON }] }])).toBe(
      PROSE_NO_JSON,
    )
  })

  it("throws ModelCallFailedError on an error-carrying assistant message — terminal, no polling", () => {
    const messages = [
      { type: "user", content: [{ type: "text", text: "go" }] },
      {
        type: "assistant",
        content: [{ type: "text", text: "" }],
        error: { type: "provider.rate-limit", message: "Usage limit reached" },
      },
    ]
    expect(() => lastAssistantText(messages)).toThrow(ModelCallFailedError)
    expect(() => lastAssistantText(messages)).toThrow(/Usage limit reached/)
  })

  it("throws a plain error when there is no assistant message yet (keeps the caller polling)", () => {
    expect(() => lastAssistantText([{ type: "user", content: [{ type: "text", text: "go" }] }])).toThrow(
      /no assistant message/,
    )
  })
})
