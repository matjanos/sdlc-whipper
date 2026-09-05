import type { CodeHost, OpenPRInput } from "../../ports/index.js"
import type { CheckStatus, PullRequest } from "../../types.js"
import { mustRun, sleep } from "../../util/exec.js"

export interface GitHubOptions {
  /** `owner/repo`; omitted → gh infers from the git remote of cwd. */
  repo?: string
  cwd?: string
}

interface GhPR {
  number: number
  url: string
  headRefName: string
  baseRefName: string
  state: string
  statusCheckRollup?: { state?: string; conclusion?: string; status?: string }[]
  reviewDecision?: string | null
}

function mapChecks(pr: GhPR): CheckStatus {
  const rollup = pr.statusCheckRollup ?? []
  if (rollup.length === 0) return { status: "unknown", summary: "no checks reported" }
  const states = rollup.map((c) => (c.conclusion ?? c.state ?? c.status ?? "").toUpperCase())
  if (states.some((s) => s === "FAILURE" || s === "ERROR" || s === "TIMED_OUT" || s === "ACTION_REQUIRED")) {
    return { status: "fail", summary: "one or more checks failed" }
  }
  if (states.some((s) => s === "PENDING" || s === "IN_PROGRESS" || s === "QUEUED")) {
    return { status: "pending", summary: "checks running" }
  }
  if (states.every((s) => s === "SUCCESS" || s === "SKIPPED" || s === "NEUTRAL")) {
    return { status: "pass", summary: "all checks green" }
  }
  return { status: "unknown", summary: `unrecognized check states: ${states.join(",")}` }
}

function normalize(pr: GhPR): PullRequest {
  return {
    number: pr.number,
    url: pr.url,
    headRef: pr.headRefName,
    baseRef: pr.baseRefName,
    state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed",
    checks: mapChecks(pr),
    reviewDecision:
      pr.reviewDecision === "APPROVED" ? "approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested" : "none",
  }
}

/**
 * GitHub adapter via the `gh` CLI: no SDK, inherits the user's auth, and the
 * same tooling the target repo already uses. Requires `gh` ≥ 2.x.
 */
export class GitHubCodeHost implements CodeHost {
  constructor(private readonly opts: GitHubOptions = {}) {}

  private repoArgs(): string[] {
    return this.opts.repo ? ["-R", this.opts.repo] : []
  }

  private async gh(args: string[], timeoutMs?: number): Promise<string> {
    const res = await mustRun(`gh ${args[0]}`, "gh", args, {
      cwd: this.opts.cwd,
      timeoutMs: timeoutMs ?? 60_000,
    })
    return res.stdout
  }

  async openPR(input: OpenPRInput): Promise<PullRequest> {
    const out = await this.gh([
      "pr",
      "create",
      ...this.repoArgs(),
      "--title",
      input.title,
      "--body",
      input.body,
      "--base",
      input.base,
      "--head",
      input.head,
    ])
    const match = out.match(/pull\/(\d+)/)
    if (!match) throw new Error(`gh pr create: cannot parse PR number from output:\n${out}`)
    return this.getPR(Number(match[1]))
  }

  async getPR(number: number): Promise<PullRequest> {
    const out = await this.gh([
      "pr",
      "view",
      String(number),
      ...this.repoArgs(),
      "--json",
      "number,url,headRefName,baseRefName,state,statusCheckRollup,reviewDecision",
    ])
    return normalize(JSON.parse(out) as GhPR)
  }

  async waitForChecks(number: number, timeoutMs: number): Promise<CheckStatus> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const pr = await this.getPR(number)
      if (pr.checks.status !== "pending" && pr.checks.status !== "unknown") return pr.checks
      if (Date.now() >= deadline) return pr.checks
      await sleep(10_000)
    }
  }

  async review(number: number, verdict: "approve" | "comment", body: string): Promise<void> {
    const flag = verdict === "approve" ? "--approve" : "--comment"
    await this.gh(["pr", "review", String(number), ...this.repoArgs(), flag, "--body", body])
  }

  async comment(number: number, body: string): Promise<void> {
    await this.gh(["pr", "comment", String(number), ...this.repoArgs(), "--body", body])
  }
}
