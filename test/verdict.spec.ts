import { describe, expect, it } from "vitest"
import { VerdictParseError, extractVerdict } from "../src/phases/shared.js"
import { deliverTask } from "../src/conductor/tick.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```'
const BARE = '{"verdict": "approve", "findings": []}'
const PROSE_ONLY =
  "The change is correct against every acceptance criterion and well tested. Approve."

describe("extractVerdict tolerance", () => {
  it("parses the last fenced ```json block", () => {
    expect(extractVerdict("review", `thoughts\n${APPROVE}\ntail`)).toEqual({ verdict: "approve", findings: [] })
  })

  it("accepts a bare JSON object when the fence is dropped", () => {
    expect(extractVerdict("review", `analysis...\n${BARE}\nnothing after`)).toEqual({
      verdict: "approve",
      findings: [],
    })
  })

  it("accepts a bare object containing braces inside strings", () => {
    const tricky = '{"verdict": "approve", "findings": [], "note": "ends with } brace"}'
    expect(extractVerdict("review", tricky)).toEqual({ verdict: "approve", findings: [], note: "ends with } brace" })
  })

  it("throws VerdictParseError when output contains no JSON object at all", () => {
    expect(() => extractVerdict("review", PROSE_ONLY)).toThrow(VerdictParseError)
  })
})

describe("verdict parse retry (bounded, conductor-owned)", () => {
  it("re-asks the same reviewer session once with a corrective nudge, then converges", async () => {
    const { config } = await makeTempRepo()
    const { deps, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { reviewer: [PROSE_ONLY, APPROVE] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("delivered")

    const reviewerPrompts = runtime.prompts.filter((p) => p.role === "reviewer")
    expect(reviewerPrompts).toHaveLength(2) // initial + one corrective re-ask
    expect(reviewerPrompts[1]!.text).toContain("verdict block")
    const executorPrompts = runtime.prompts.filter((p) => p.role === "executor")
    expect(executorPrompts).toHaveLength(1) // verdict was approve — no executor re-run
  })

  it("fails the phase after the single corrective re-ask (no unbounded loop)", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { reviewer: [PROSE_ONLY, PROSE_ONLY] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("failed")

    const reviewerPrompts = runtime.prompts.filter((p) => p.role === "reviewer")
    expect(reviewerPrompts).toHaveLength(2) // initial + exactly one corrective re-ask
    const comment = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(comment!.args)).toContain("sdlc:phase-error")
  })
})
