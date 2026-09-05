import { describe, expect, it } from "vitest"
import { deliverTask } from "../src/conductor/tick.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const CHANGES = '```json\n{"verdict": "changes_requested", "findings": [{"severity": "major", "file": "src/x.ts", "issue": "wrong", "suggestion": "right"}]}\n```'
const APPROVE = '```json\n{"verdict": "approve", "findings": []}\n```'

describe("executor ↔ reviewer loop (bounded, conductor-owned)", () => {
  it("converges on round 2: executor re-prompted with findings, reviewer fresh", async () => {
    const { config } = await makeTempRepo()
    const { deps, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { reviewer: [CHANGES, APPROVE] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("delivered")

    const executorPrompts = runtime.prompts.filter((p) => p.role === "executor")
    const reviewerPrompts = runtime.prompts.filter((p) => p.role === "reviewer")
    expect(executorPrompts).toHaveLength(2) // initial + follow-up
    expect(reviewerPrompts).toHaveLength(2) // fresh each round
    expect(executorPrompts[1]!.text).toContain("wrong") // findings fed back
    expect(executorPrompts[1]!.text).toContain("right")
  })

  it("escalates stalemate to the ticket when rounds run out", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: { reviewer: [CHANGES, CHANGES, CHANGES, CHANGES] },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("parked")
    const comment = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(comment!.args)).toContain("sdlc:stalemate")
    // default cap is 3 rounds → 3 reviewer prompts, 3 executor prompts
    expect(runtime.prompts.filter((p) => p.role === "reviewer")).toHaveLength(3)
    expect(runtime.prompts.filter((p) => p.role === "executor")).toHaveLength(3)
  })
})
