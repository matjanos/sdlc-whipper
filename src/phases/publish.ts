import { branchName } from "../git/worktrees.js"
import { commitAll, hasCommits, push } from "../git/repo.js"
import { openPR } from "../conductor/actions.js"
import { definePhase, type PublishResult } from "./base.js"
import type { ReviewResult } from "./base.js"

/**
 * Publish (pure conductor step): commit the worktree, push, open the PR.
 * Stub-safe: with no commits (stub prompts), it skips — so a dry run never
 * opens an empty PR.
 */
export const publishPhase = definePhase<PublishResult>({
  name: "publish",
  usesLLM: false,
  run: async (task) => {
    const base = task.deps.config.raw.repo.baseBranch
    if (!task.worktree || !(await hasCommits(task.worktree, base))) {
      task.deps.log.info("publish: no commits in worktree — skipping PR (stub run)")
      return { skipped: true }
    }
    const review = task.artifacts.getJSON<ReviewResult>("reviews/r1.json")
    const branch = branchName(task.deps.config, task.ticket.key)
    await commitAll(task.worktree, `sdlc: ${task.ticket.key} — ${task.ticket.title}`)
    await push(task.worktree, branch)
    const pr = await openPR(task.deps, {
      title: `${task.ticket.key}: ${task.ticket.title}`,
      body: [
        `Delivered autonomously for ${task.ticket.key}: ${task.ticket.title}`,
        task.ticket.url ? `\nTicket: ${task.ticket.url}` : "",
        review ? `\n**Reviewer verdict:** ${review.verdict} (${review.findings.length} findings resolved)` : "",
        `\n**Preview:** https://pr-<N>-${task.deps.config.raw.preview.project}.vercel.app (once deployed)`,
        `\n**Cost:** see \`sdlc ledger --ticket ${task.ticket.key}\``,
      ]
        .filter(Boolean)
        .join("\n"),
      head: branch,
      base,
    })
    return pr ? { skipped: false, pr: { number: pr.number, url: pr.url } } : { skipped: true }
  },
})
