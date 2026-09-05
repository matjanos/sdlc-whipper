import { approvePR } from "../conductor/actions.js"
import { renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, testResultSchema, type TestResult } from "./base.js"
import { EscalationError } from "../types.js"
import type { AwaitPreviewResult, SplitResult } from "./base.js"

/**
 * Tester: runs against the PR's live preview environment (Playwright on the
 * stable per-PR URL) and approves the PR when the acceptance check passes.
 * Merging stays human-only — this approval is a gate, not the merge.
 */
export const testPhase = definePhase<TestResult>({
  name: "test",
  usesLLM: true,
  role: "tester",
  input: async (task, outcomes) => {
    const preview = outcomes["await-preview"] as AwaitPreviewResult | undefined
    if (!preview?.url) throw new Error("test: no preview URL — phase should have been skipped")
    const split = task.artifacts.getJSON<SplitResult>("acceptance.json")
    return {
      text: renderPrompt("test", {
        ticket: truncate(task.ticket.title, 500),
        acceptance: split ? truncate(`${split.acceptanceTest} (test at ${split.testPath})`, 4_000) : "(missing)",
        previewUrl: preview.url,
      }),
    }
  },
  parse: async (output) => validateVerdict("test", output, testResultSchema),
  onResult: async (task, result, outcomes) => {
    task.artifacts.setJSON("test.json", result)
    const publish = outcomes["publish"] as { pr?: { number: number } } | undefined
    if (result.pass && publish?.pr) {
      await approvePR(
        task.deps,
        publish.pr.number,
        `sdlc tester: acceptance check passed against ${task.artifacts.get("preview.txt")}\n\n${result.evidence}`,
      )
      return
    }
    if (!result.pass) {
      throw new EscalationError("test-failed", result.evidence)
    }
  },
})
