import type { CheckStatus, PullRequest } from "../types.js"

export interface OpenPRInput {
  title: string
  body: string
  head: string
  base: string
}

/**
 * Code host port. Default adapter: GitHub (via `gh` CLI). Plain git operations
 * (worktrees, branches, commit, push) deliberately live in `src/git/` instead —
 * git itself is the abstraction there.
 */
export interface CodeHost {
  openPR(input: OpenPRInput): Promise<PullRequest>

  getPR(number: number): Promise<PullRequest>

  /** Poll until checks finish or timeout. Returns final status; never throws on red checks. */
  waitForChecks(number: number, timeoutMs: number): Promise<CheckStatus>

  /** The tester's approval lands here. Merge stays human-only. */
  review(number: number, verdict: "approve" | "comment", body: string): Promise<void>

  comment(number: number, body: string): Promise<void>
}
