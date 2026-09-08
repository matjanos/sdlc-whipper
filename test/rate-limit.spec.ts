import { describe, expect, it } from "vitest"
import { ModelCallFailedError } from "../src/types.js"
import { deliverTask } from "../src/conductor/tick.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

/**
 * Provider quota windows (e.g. Z.AI coding plan 5h cap) must park the ticket
 * with an escalation — not fail the phase and not burn retries against a wall.
 */
describe("provider rate-limit handling", () => {
  it("parks the ticket with a provider-rate-limit escalation", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: {
        reviewer: [
          new ModelCallFailedError(
            '{"type":"provider.rate-limit","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-09-08 10:13:21","status":429}',
          ),
        ],
      },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("parked")

    const comment = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(comment!.args)).toContain("sdlc:provider-rate-limit")
    expect(JSON.stringify(comment!.args)).toContain("Usage limit reached for 5 hour")
    // the retry wrapper must not hammer a rate-limited provider
    expect(runtime.prompts.filter((p) => p.role === "reviewer")).toHaveLength(1)
  })

  it("treats other provider errors as plain phase failures", async () => {
    const { config } = await makeTempRepo()
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })], {
      runtimeScript: {
        reviewer: [new ModelCallFailedError('{"type":"provider.auth","message":"Token refresh failed: 401"}')],
      },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("failed")
    const comment = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(comment!.args)).toContain("sdlc:phase-error")
    expect(JSON.stringify(comment!.args)).not.toContain("provider-rate-limit")
  })
})
