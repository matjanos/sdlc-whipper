import path from "node:path"
import type { Server } from "node:http"
import { afterAll, describe, expect, it } from "vitest"
import { Budget } from "../src/conductor/budget.js"
import { createCockpitServer } from "../src/conductor/server.js"
import { readRunEvents } from "../src/conductor/run-events.js"
import { deliverTask, runTick } from "../src/conductor/tick.js"
import type { LedgerStore } from "../src/ports/index.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const servers: Server[] = []
afterAll(() => {
  for (const s of servers) s.close()
})

/**
 * AXI-25: usage events land as large CUMULATIVE chunks mid-prompt, so the
 * per-task cap is overshot inside a single phase call. The ledger must carry
 * deltas (true spend), and the guard must park the run — including mid-prompt
 * via the watchdog — within one chunk of crossing the cap.
 */

const CAP = 1_000_000

const budgetConfig = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  budget: { maxParallelDeliveries: 2, perTaskUsd: 3, perTaskTokens: CAP, maxLoopRounds: 3, ...extra },
})

/** rollup("run") exposes the delivery's runId without reaching into deliverTask internals. */
async function soleRunId(deps: ReturnType<typeof wireFakes>["deps"]): Promise<string> {
  const [run] = await deps.ledger.rollup("run")
  expect(run).toBeDefined()
  return run!.key
}

describe("cumulative usage chunks vs the per-task budget", () => {
  it("parks with sdlc:budget-exceeded while the ledger holds the true spend (deltas), not the snapshot sum", async () => {
    const { config } = await makeTempRepo(budgetConfig())
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })], {
      fakeRuntime: { usageChunks: { tokensPerCall: 400_000 } },
    })
    const report = await runTick(deps)

    expect(report.candidates[0]!.status).toBe("parked")
    const escalateCall = tracker.calls.find((c) => c.op === "comment")
    expect(escalateCall).toBeDefined()
    expect(JSON.stringify(escalateCall!.args)).toContain("sdlc:budget-exceeded")

    const runId = await soleRunId(deps)
    const [run] = await deps.ledger.rollup("run")
    expect(run!.runs).toBe(3) // split + research + execute — delta entries only
    const usage = await deps.ledger.usage(runId)
    expect(usage.tokens).toBe(1_200_000) // the session's true cumulative spend at the park
    expect(usage.tokens).toBeLessThanOrEqual(CAP + 400_000) // parked within one chunk of the cap
    expect(usage.tokens).not.toBe(400_000 + 800_000 + 1_200_000) // never the sum of the cumulative snapshots
  })

  it("watchdog parks mid-prompt when a chunk lands while it is in flight — interruptAll fires, late results dropped", async () => {
    const { config } = await makeTempRepo(budgetConfig({ watchdogMs: 20 }))
    const { deps, tracker, runtime } = wireFakes(config, [ticket({ key: "TST-1" })], {
      fakeRuntime: { usageChunks: { tokensPerCall: 1_200_000, delayMs: 40, hangUntilInterrupt: true } },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("parked")

    await runtime.settle() // late chunk writes from the released prompt must land before asserting
    expect(runtime.interruptAllCalls).toBeGreaterThanOrEqual(1)
    expect(runtime.prompts).toHaveLength(1) // parked inside the first hung prompt — no later phase ran

    const [run] = await deps.ledger.rollup("run")
    const usage = await deps.ledger.usage(run!.key)
    expect(run!.runs).toBe(1) // exactly one chunk recorded — nothing after the park
    expect(usage.tokens).toBe(1_200_000)

    const escalateCall = tracker.calls.find((c) => c.op === "comment")
    expect(JSON.stringify(escalateCall!.args)).toContain("sdlc:budget-exceeded")
  }, 15_000)

  it("warns once at 80% of the cap onto the run timeline, then parks on the overshoot", async () => {
    const { config } = await makeTempRepo(budgetConfig())
    const { deps, tracker } = wireFakes(config, [ticket({ key: "TST-1" })], {
      fakeRuntime: { usageChunks: { tokensPerCall: 850_000 } },
    })
    const status = await deliverTask(deps, await deps.tracker.getTicket("TST-1"))
    expect(status).toBe("parked")

    const events = readRunEvents(path.join(config.artifactsDir, "TST-1", "events.jsonl"))
    const warnings = events.filter((e) => e.level === "warn" && e.text.startsWith("budget warning"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]!.text).toContain("85%")

    const [run] = await deps.ledger.rollup("run")
    const usage = await deps.ledger.usage(run!.key)
    expect(usage.tokens).toBe(1_700_000) // two chunks — parked at the second overshoot
    expect(usage.tokens).toBeLessThanOrEqual(CAP + 850_000)
    expect(JSON.stringify(tracker.calls.find((c) => c.op === "comment")!.args)).toContain("sdlc:budget-exceeded")
  })

  it("keeps guard and cockpit in parity: budget.byTicket sums the same deltas the guard asserts on", async () => {
    const { config } = await makeTempRepo(budgetConfig())
    const { deps } = wireFakes(config, [ticket({ key: "TST-1" })], {
      fakeRuntime: { usageChunks: { tokensPerCall: 400_000 } },
    })
    await deliverTask(deps, await deps.tracker.getTicket("TST-1"))

    const server = await createCockpitServer(deps, { port: 0 })
    servers.push(server)
    const address = server.address()
    if (!address || typeof address !== "object") throw new Error("server did not expose a port")
    const res = await fetch(`http://127.0.0.1:${address.port}/api/state`)
    const snap = (await res.json()) as { budget: { byTicket: { key: string; tokens: number }[] } }

    const runId = await soleRunId(deps)
    const usage = await deps.ledger.usage(runId)
    const row = snap.budget.byTicket.find((t) => t.key === "TST-1")
    expect(row?.tokens).toBe(usage.tokens)
    expect(usage.tokens).toBe(1_200_000)
  })
})

describe("Budget soft warning", () => {
  const ledgerWith = (usage: { tokens: number; costUsd: number }): LedgerStore => ({
    record: async () => {},
    rollup: async () => [],
    usage: async () => usage,
  })

  it("warns once per run at 80% of the token cap and never re-warns", async () => {
    const usage = { tokens: 850_000, costUsd: 0 }
    const budget = new Budget({ tokens: CAP, costUsd: 3 }, ledgerWith(usage))
    const warnings: string[] = []
    const opts = { onWarning: (m: string) => warnings.push(m) }
    await budget.assert("run_1", opts)
    await budget.assert("run_1", opts)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("85%")

    usage.tokens = 100 // a run below the threshold stays silent
    await budget.assert("run_2", opts)
    expect(warnings).toHaveLength(1)
  })

  it("warns on the cost cap too, and stays silent below the threshold", async () => {
    const warnings: string[] = []
    const opts = { onWarning: (m: string) => warnings.push(m) }
    await new Budget({ tokens: CAP, costUsd: 3 }, ledgerWith({ tokens: 0, costUsd: 2.7 })).assert("run_1", opts)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("90%")

    await new Budget({ tokens: CAP, costUsd: 3 }, ledgerWith({ tokens: 100, costUsd: 0.1 })).assert("run_2", opts)
    expect(warnings).toHaveLength(1)
  })
})
