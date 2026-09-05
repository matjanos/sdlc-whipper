import { describe, expect, it } from "vitest"
import { deliverTask } from "../src/conductor/tick.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const LOW_CONFIDENCE = '```json\n{"confidence": "low", "questions": ["CQ-1: how should X behave on empty input?"], "planMarkdown": "# Plan (draft)"}\n```'
const ADVICE = '```json\n{"advice": "Do X, then Y.", "needsHuman": false}\n```'
const NEEDS_HUMAN = '```json\n{"advice": "This is a product decision.", "needsHuman": true}\n```'

describe("council routing", () => {
  it("does not summon the council on high confidence", async () => {
    const { config } = await makeTempRepo()
    const { deps, runtime } = wireFakes(config, [ticket({ key: "TST-1" })])
    await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(runtime.prompts.some((p) => p.role === "council")).toBe(false)
  })

  it("summons the council on low confidence and continues after advice", async () => {
    const { config } = await makeTempRepo()
    const { deps, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { researcher: [LOW_CONFIDENCE], council: [ADVICE] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("delivered")
    const councilPrompt = runtime.prompts.find((p) => p.role === "council")!
    expect(councilPrompt.text).toContain("CQ-1")
  })

  it("escalates needs-info to the human when the council refuses to guess", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { researcher: [LOW_CONFIDENCE], council: [NEEDS_HUMAN] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("escalated")
    const comment = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(comment!.args)).toContain("sdlc:needs-info")
    expect(JSON.stringify(comment!.args)).toContain("CQ-1")
    // needs-info label applied
    expect(tracker.calls).toContainEqual({ op: "addLabel", args: ["TST-1", "needs-info"] })
  })
})
