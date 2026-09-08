import { describe, expect, it } from "vitest"
import {
  renderDeliveryResult,
  renderHarnesses,
  renderHelp,
  renderHitch,
  renderLedger,
  renderRunSummary,
  renderStatus,
} from "../src/cli/ui.js"
import type { StatusReport } from "../src/conductor/status.js"

const report: StatusReport = {
  workspace: { team: "ENG" },
  ready: [{ key: "ENG-12", title: "Ship the friendly CLI" }],
  blocked: [{ key: "ENG-13", title: "Publish package", blocker: "ENG-12 (backlog)" }],
  waitingForHuman: [{ key: "ENG-14", title: "Choose an open-source license" }],
  inFlight: [{ key: "ENG-11", title: "Review naming" }],
  config: {
    adapters: "fake/fake/fake/fake",
    phasesEnabled: ["split", "execute", "review"],
    budget: { maxParallelDeliveries: 2, perTaskUsd: 5, perTaskTokens: 100_000 },
    dryRun: false,
  },
  wouldDeliverNow: 1,
}

describe("friendly CLI skin", () => {
  it("makes hit the primary dispatch command and documents compatibility", () => {
    const help = renderHelp()
    expect(help).toContain("whipper crack --dry-run")
    expect(help).toContain("whipper hit LIN-123")
    expect(help).toContain("deliver` / `run` / `tick` / `serve`")
    expect(help).toContain("focused harness")
    expect(help).toContain("Merging always stays human")
  })

  it("turns status into a clear team briefing with a next action", () => {
    const text = renderStatus(report)
    expect(text).toContain("●  1  ready at the gate")
    expect(text).toContain("■  1  held by dependencies")
    expect(text).toContain("waiting for ENG-12 (backlog)")
    expect(text).toContain("whipper crack")
    expect(text).not.toContain("\u001B[")
  })

  it("renders a compact ledger with human token units", () => {
    const text = renderLedger("ticket", [{ key: "ENG-12", runs: 4, tokens: 12_500, costUsd: 1.25 }])
    expect(text).toContain("12.5k")
    expect(text).toContain("$1.25")
    expect(text).toContain("TOTAL")
  })

  it("labels zero-cost spend as plan-covered instead of a misleading $0", () => {
    const summary = renderRunSummary(
      [{ key: "ENG-12", status: "delivered" }],
      [{ key: "ENG-12", runs: 35, tokens: 4_036_600, costUsd: 0 }],
    )
    expect(summary).toContain("no metered cost")
    expect(summary).toContain("4.0m tokens")
    expect(summary).toContain("tokens are the real meter")

    const ledger = renderLedger("ticket", [{ key: "ENG-12", runs: 35, tokens: 4_036_600, costUsd: 0 }])
    expect(ledger).toContain("no metered cost")
  })

  it("does not claim a dry run reached the real human gate", () => {
    expect(renderDeliveryResult("ENG-12", "delivered", {}, true)).toContain("practice route complete")
    expect(renderDeliveryResult("ENG-12", "failed", {}, true)).toContain("×")
  })

  it("explains configured harnesses and project hitching", () => {
    const harnesses = renderHarnesses([{ role: "executor", modelClass: "workhorse", model: "openai/model", steps: 40 }])
    expect(harnesses).toContain("restrained specialists")
    expect(harnesses).toContain("workhorse")
    expect(harnesses).toContain("≤40 steps")

    const hitch = renderHitch({
      project: "shop",
      configPath: "/shop/.sdlc/config.json",
      team: "ENG",
      harnesses: 7,
      adapters: { tracker: "linear", codehost: "github", preview: "vercel", runtime: "opencode" },
    })
    expect(hitch).toContain("project team connected")
    expect(hitch).toContain("whipper status")
  })
})
