import { renderPrompt, truncate } from "./shared.js"
import { definePhase } from "./base.js"
import type { ReviewResult, SplitResult } from "./base.js"

/**
 * Executor: implements the plan in the worktree. The conductor pushes — the
 * executor's shell permission denies `git push`.
 *
 * Follow-up rounds: when the reviewer requests changes, the runner re-runs this
 * phase with the findings appended. Same agent session, so implementation
 * context survives across review rounds.
 */
export const executePhase = definePhase<string>({
  name: "execute",
  usesLLM: true,
  role: "executor",
  input: async (task, outcomes) => {
    const plan = task.artifacts.get("plan.md") ?? "(no plan — this is a bug)"
    const acceptance = task.artifacts.get("acceptance.json") ?? "{}"
    const split = JSON.parse(acceptance) as SplitResult
    const review = outcomes["review"] as ReviewResult | undefined
    const findings = review
      ? review.findings
          .map((f, i) => `${i + 1}. [${f.severity}]${f.file ? ` (${f.file})` : ""} ${f.issue}${f.suggestion ? `\n   → ${f.suggestion}` : ""}`)
          .join("\n")
      : ""
    return {
      text: renderPrompt("execute", {
        plan: truncate(plan, 20_000),
        acceptance: truncate(`${split.acceptanceTest}\n(test at ${split.testPath})`, 4_000),
        ticket: task.ticket.key,
        title: task.ticket.title,
        worktree: task.worktree ?? "",
        findings,
      }),
    }
  },
  parse: async (output) => output.trim(),
  onResult: async (task, summary) => {
    task.artifacts.append("execution.md", `## Execution round\n\n${summary}`)
  },
})
