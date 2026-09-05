import type { CodeHost, OpenPRInput } from "../../ports/index.js"
import type { CheckStatus, PullRequest } from "../../types.js"

export interface FakeCodeHostOptions {
  /** Number of polls before checks turn green (default 1 — first waitForChecks is green). */
  pollsUntilGreen?: number
  calls?: { op: string; args: unknown[] }[]
}

export class FakeCodeHost implements CodeHost {
  private prs = new Map<number, PullRequest>()
  private seq = 1
  private polls = 0
  readonly calls: { op: string; args: unknown[] }[]

  constructor(private readonly opts: FakeCodeHostOptions = {}) {
    this.calls = opts.calls ?? []
  }

  async openPR(input: OpenPRInput): Promise<PullRequest> {
    this.calls.push({ op: "openPR", args: [input] })
    const number = this.seq++
    const pr: PullRequest = {
      number,
      url: `https://github.com/example/repo/pull/${number}`,
      headRef: input.head,
      baseRef: input.base,
      state: "open",
      checks: { status: "unknown", summary: "no checks yet" },
      reviewDecision: "none",
    }
    this.prs.set(number, pr)
    return { ...pr }
  }

  async getPR(number: number): Promise<PullRequest> {
    this.calls.push({ op: "getPR", args: [number] })
    const pr = this.prs.get(number)
    if (!pr) throw new Error(`fake codehost: no PR #${number}`)
    return { ...pr }
  }

  async waitForChecks(number: number, _timeoutMs: number): Promise<CheckStatus> {
    this.calls.push({ op: "waitForChecks", args: [number] })
    this.polls += 1
    if (this.polls < (this.opts.pollsUntilGreen ?? 1)) {
      return { status: "pending", summary: "checks running" }
    }
    const pr = this.prs.get(number)
    if (pr) pr.checks = { status: "pass", summary: "all green" }
    return { status: "pass", summary: "all green" }
  }

  async review(number: number, verdict: "approve" | "comment", body: string): Promise<void> {
    this.calls.push({ op: "review", args: [number, verdict, body] })
    const pr = this.prs.get(number)
    if (!pr) throw new Error(`fake codehost: no PR #${number}`)
    if (verdict === "approve") pr.reviewDecision = "approved"
  }

  async comment(number: number, body: string): Promise<void> {
    this.calls.push({ op: "comment", args: [number, body] })
  }
}
