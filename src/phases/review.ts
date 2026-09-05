import { diffFor } from "../git/repo.js"
import { formatTicket, renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, reviewResultSchema, type ReviewResult } from "./base.js"

/**
 * Reviewer: honest review of the diff in the context of the task.
 *
 * CONTEXT FIREWALL (asserted by test/firewall.spec.ts):
 *   gets → ticket + diff
 *   never gets → plan.md, council advice, researcher questions, execution notes
 * The runner also prompts it with `fresh: true` so no session state leaks
 * between rounds.
 */
export const reviewPhase = definePhase<ReviewResult>({
  name: "review",
  usesLLM: true,
  role: "reviewer",
  input: async (task) => {
    if (!task.worktree) throw new Error("review: no worktree")
    const diff = await diffFor(task.worktree, task.deps.config.raw.repo.baseBranch)
    return {
      text: renderPrompt("review", {
        ticket: truncate(formatTicket(task.ticket), 8_000),
        diff: truncate(diff, 40_000),
      }),
    }
  },
  parse: async (output) => validateVerdict("review", output, reviewResultSchema),
  onResult: async (task, result, outcomes) => {
    const round = Object.keys(outcomes).filter((k) => k.startsWith("review")).length
    task.artifacts.setJSON(`reviews/r${round}.json`, result)
  },
})
