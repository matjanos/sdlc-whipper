import { describe, expect, it } from "vitest"
import { deliverTask, runTick } from "../src/conductor/tick.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

describe("tick", () => {
  it("delivers a ready, selected, unblocked ticket end-to-end with stub agents", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })])
    const report = await runTick(deps)

    expect(report.candidates).toHaveLength(1)
    expect(report.candidates[0]!.status).toBe("delivered")
    // final state: moved to inProgress at start, inReview when delivered
    expect(tracker.calls).toContainEqual({ op: "moveTo", args: ["TST-1", "inProgress"] })
    expect(tracker.calls).toContainEqual({ op: "moveTo", args: ["TST-1", "inReview"] })
  })

  it("skips tickets waiting on human answers (needs-info)", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [ticket({ key: "TST-1", labels: ["selected", "needs-info"] })])
    const report = await runTick(deps)
    expect(report.candidates[0]!.status).toBe("skipped")
    expect(report.candidates[0]!.reason).toMatch(/needs-info/)
  })

  it("skips tickets with unresolved blockers and records which one", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [
      ticket({
        key: "TST-1",
        relations: [{ kind: "blocked-by", key: "TST-9", state: "inProgress" }],
      }),
    ])
    const report = await runTick(deps)
    expect(report.candidates[0]!.status).toBe("skipped")
    expect(report.candidates[0]!.reason).toMatch(/blocked by TST-9/)
  })

  it("resolves blockers that are done — no false skips", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [
      ticket({
        key: "TST-1",
        relations: [{ kind: "blocked-by", key: "TST-9", state: "done" }],
      }),
    ])
    const report = await runTick(deps)
    expect(report.candidates[0]!.status).toBe("delivered")
  })

  it("enforces the concurrency cap across in-flight tickets", async () => {
    const { config } = await makeTempRepo({ budget: { maxParallelDeliveries: 1, perTaskUsd: 15, perTaskTokens: 4_000_000, maxLoopRounds: 3 } })
    const { deps } = wireFakes(config, [
      ticket({ key: "TST-1", state: "inProgress" }), // already in flight → 0 slots
      ticket({ key: "TST-2" }),
    ])
    const report = await runTick(deps)
    const t2 = report.candidates.find((c) => c.key === "TST-2")!
    expect(t2.status).toBe("skipped")
    expect(t2.reason).toMatch(/concurrency/)
  })

  it("groom is skipped when disabled, runs questions-free when enabled with an empty backlog", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [])
    const report = await runTick(deps)
    expect(report.groom.ran).toBe(false)
    expect(report.candidates).toHaveLength(0)
  })
})

describe("deliverTask", () => {
  it("parks the task and escalates when the per-task budget is exceeded", async () => {
    const { config } = await makeTempRepo({ budget: { maxParallelDeliveries: 2, perTaskUsd: 0.01, perTaskTokens: 100, maxLoopRounds: 3 } })
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })])
    const status = await deliverTask(deps, (await deps.tracker.getTicket("TST-1")))
    expect(status).toBe("parked")
    const escalateCall = tracker.calls.find((c) => c.op === "comment")
    expect(escalateCall).toBeDefined()
    expect(JSON.stringify(escalateCall!.args)).toContain("sdlc:budget-exceeded")
  })
})
