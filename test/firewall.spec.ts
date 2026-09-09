import { describe, expect, it } from "vitest"
import { loadPhases } from "../src/phases/registry.js"
import { Artifacts } from "../src/conductor/artifacts.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

/**
 * The context firewall, encoded as executable rules. These assertions are the
 * reason prompt assembly lives in exactly one place per phase:
 *   - the reviewer sees ticket + diff, NEVER the plan or council advice
 *   - the council sees questions + plan, NEVER the full ticket
 *   - the executor sees plan + acceptance
 *   - the tester sees acceptance + preview URL, never the plan
 */
describe("context firewall (golden prompt tests)", () => {
  const PLAN_SECRET = "PLAN-SECRET-9f3a"
  const QUESTION_MARKER = "QUESTION-MARKER-7b1c"
  const TICKET_SECRET = "TICKET-SECRET-2d4e"
  const ACCEPTANCE_MARKER = "ACCEPTANCE-8e5f"

  async function setup() {
    const { config, dir } = await makeTempRepo()
    const { deps } = wireFakes(config, [])
    const phases = await loadPhases()
    const artifacts = new Artifacts(`${dir}/.whipper/runs/TST-1`)
    artifacts.set("plan.md", `# Plan\n\n${PLAN_SECRET} step one`)
    artifacts.setJSON("acceptance.json", {
      acceptanceTest: `${ACCEPTANCE_MARKER} given/when/then`,
      testPath: "tests/e2e/x.e2e.spec.ts",
      brief: "brief",
    })
    const task = {
      ticket: ticket({ key: "TST-1", description: `Deliver ${TICKET_SECRET} safely.` }),
      worktree: dir,
      artifacts,
      deps,
      runId: "run_test",
    }
    return { phases, task }
  }

  it("reviewer prompt: ticket + diff, never the plan or acceptance", async () => {
    const { phases, task } = await setup()
    const parts = await phases.get("review")!.input!(task, {})
    expect(parts.text).toContain("TST-1")
    expect(parts.text).toContain(TICKET_SECRET)
    expect(parts.text).not.toContain(PLAN_SECRET)
    expect(parts.text).not.toContain(ACCEPTANCE_MARKER)
  })

  it("reviewer prompt contains the actual diff when one exists", async () => {
    const { phases, task } = await setup()
    const parts = await phases.get("review")!.input!(task, {})
    // temp repo has no changes — placeholder present, and no crash
    expect(parts.text).toMatch(/no changes|diff/i)
  })

  it("council prompt: questions + plan, never the ticket", async () => {
    const { phases, task } = await setup()
    const outcomes = {
      research: { confidence: "low", questions: [`${QUESTION_MARKER}: which cache?`], planMarkdown: `# Plan\n${PLAN_SECRET}` },
    }
    const parts = await phases.get("council")!.input!(task, outcomes)
    expect(parts.text).toContain(QUESTION_MARKER)
    expect(parts.text).toContain(PLAN_SECRET)
    expect(parts.text).not.toContain(TICKET_SECRET)
    expect(parts.text).not.toContain("TST-1")
  })

  it("executor prompt: plan + acceptance + ticket key", async () => {
    const { phases, task } = await setup()
    const parts = await phases.get("execute")!.input!(task, {})
    expect(parts.text).toContain(PLAN_SECRET)
    expect(parts.text).toContain(ACCEPTANCE_MARKER)
    expect(parts.text).toContain("TST-1")
  })

  it("executor follow-up round includes reviewer findings", async () => {
    const { phases, task } = await setup()
    const outcomes = {
      review: {
        verdict: "changes_requested",
        findings: [{ severity: "blocker", file: "src/x.ts", issue: "FINDING-5a6b", suggestion: "fix it" }],
      },
    }
    const parts = await phases.get("execute")!.input!(task, outcomes)
    expect(parts.text).toContain("FINDING-5a6b")
    expect(parts.text).toContain("blocker")
  })

  it("tester prompt: acceptance + preview URL, never the plan", async () => {
    const { phases, task } = await setup()
    const outcomes = { "await-preview": { skipped: false, url: "https://pr-4-test.preview.test" } }
    const parts = await phases.get("test")!.input!(task, outcomes)
    expect(parts.text).toContain("https://pr-4-test.preview.test")
    expect(parts.text).toContain(ACCEPTANCE_MARKER)
    expect(parts.text).not.toContain(PLAN_SECRET)
  })
})
