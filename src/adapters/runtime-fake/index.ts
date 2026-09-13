import type { AgentRuntime, PromptOptions, RunContext } from "../../ports/index.js"
import type { LedgerStore } from "../../ports/index.js"
import type { AgentRole, PromptParts } from "../../types.js"
import { sleep } from "../../util/exec.js"
import { usageEntryFromEvent, UsageDeltaTracker } from "../runtime-opencode/usage.js"

/** Opt-in chunked-usage scripting: the real server reports usage in large cumulative chunks mid-prompt. */
export interface FakeUsageChunks {
  /** Session spend added by every prompt, reported as an absolute cumulative snapshot (opencode-shaped). */
  tokensPerCall: number
  /** Delay before each chunk lands and the prompt resolves — models a long-running phase. */
  delayMs?: number
  /** Keep the prompt in flight until interruptAll() — exercises the budget watchdog. */
  hangUntilInterrupt?: boolean
}

export interface FakeRuntimeOptions {
  /** Per-role scripted outputs (consumed in order; falls back to defaults). An Error entry is thrown — for provider-failure paths. */
  script?: Partial<Record<AgentRole, (string | Error)[]>>
  /** Multiply emitted token counts — makes budget-exceeded paths testable. */
  tokenBoost?: number
  ledger?: LedgerStore
  /** Every prompt, in order — the firewall tests assert against these. */
  prompts?: { role: AgentRole; text: string }[]
  /** Emit cumulative `session.usage.updated` snapshots after each prompt; the ledgered delta goes through the real delta tracker. */
  usageChunks?: FakeUsageChunks
}

const DEFAULTS: Record<AgentRole, string> = {
  split: '```json\n{"acceptanceTest": "Given the feature is implemented, the acceptance scenario passes.", "testPath": "tests/e2e/stub.e2e.spec.ts", "brief": "Stub acceptance derived from the ticket."}\n```',
  researcher:
    '```json\n{"confidence": "high", "questions": [], "planMarkdown": "# Plan (stub)\\n\\n1. Read the ticket.\\n2. Implement minimally.\\n3. Make the acceptance test pass."}\n```',
  council: '```json\n{"advice": "Proceed; keep the change minimal.", "needsHuman": false}\n```',
  executor: "Stub execution: touched files according to the plan. (stub output)",
  reviewer: '```json\n{"verdict": "approve", "findings": []}\n```',
  tester: '```json\n{"pass": true, "evidence": "Stub test run against the preview URL."}\n```',
  groomer:
    '```json\n{"selected": [], "classifications": [], "relations": [], "splits": [], "questions": []}\n```',
}

/**
 * Scripted runtime. Consumes `script[role]` entries in order, then falls back
 * to role defaults — enough to walk the entire pipeline offline. Records
 * plausible ledger entries so Budget and rollups are exercised for real.
 */
export class FakeRuntime implements AgentRuntime {
  private run?: RunContext
  private queue: Partial<Record<AgentRole, (string | Error)[]>>
  readonly prompts: { role: AgentRole; text: string }[]
  /** Times interruptAll() was called — the watchdog test asserts on this. */
  interruptAllCalls = 0
  // chunked-usage state: per-role session baselines + late-write tracking
  private readonly usageDeltas = new UsageDeltaTracker()
  private readonly cumulative = new Map<string, number>() // sessionID → true lifetime spend
  private readonly waiters: (() => void)[] = []
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly opts: FakeRuntimeOptions = {}) {
    // Per-role array copy — NOT structuredClone: it downgrades custom Error
    // subclasses to base Error, breaking instanceof-based flow control.
    this.queue = Object.fromEntries(
      Object.entries(opts.script ?? {}).map(([role, entries]) => [role, [...(entries ?? [])]]),
    )
    this.prompts = opts.prompts ?? []
  }

  async open(run: RunContext): Promise<void> {
    this.run = run
    this.usageDeltas.reset()
    this.cumulative.clear()
  }

  async prompt(role: AgentRole, parts: PromptParts, _opts?: PromptOptions): Promise<string> {
    const done = this.doPrompt(role, parts)
    // settle() must also cover hung prompts finishing after interruptAll()
    this.tail = this.tail.catch(() => undefined).then(() => done.catch(() => undefined))
    return done
  }

  private async doPrompt(role: AgentRole, parts: PromptParts): Promise<string> {
    this.prompts.push({ role, text: parts.text })
    const queue = this.queue[role]
    const output = queue?.shift() ?? DEFAULTS[role]!
    if (output instanceof Error) throw output
    if (this.opts.usageChunks) {
      await this.emitUsageChunk(role)
    } else if (this.opts.ledger && this.run) {
      const est = Math.ceil((parts.text.length + output.length) / 4) * (this.opts.tokenBoost ?? 1)
      await this.opts.ledger.record({
        runId: this.run.runId,
        ticket: this.run.ticket,
        phase: "tick",
        agent: role,
        model: "fake/stub",
        ts: new Date().toISOString(),
        tokens: { input: est, output: 1 },
        costUsd: null,
      })
    }
    return output
  }

  /**
   * Emit one cumulative `session.usage.updated` snapshot for this role's
   * session while the prompt is still in flight — exactly the overshoot
   * window the budget guard has to catch — and ledger the DELTA through the
   * same tracker the real runtime uses, so a test over the fake proves the
   * ledger sums to true spend, never to the snapshot sum.
   */
  private async emitUsageChunk(role: AgentRole): Promise<void> {
    const chunks = this.opts.usageChunks!
    if (chunks.delayMs) await sleep(chunks.delayMs)
    if (this.opts.ledger && this.run) {
      const sessionID = `ses_${this.run.runId}_${role}`
      const total = (this.cumulative.get(sessionID) ?? 0) + chunks.tokensPerCall
      this.cumulative.set(sessionID, total)
      const entry = usageEntryFromEvent(
        {
          type: "session.usage.updated",
          data: {
            sessionID,
            cost: 0,
            tokens: { input: total, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        },
        new Map([[sessionID, role]]),
        { runId: this.run.runId, ticket: this.run.ticket, modelFor: () => "fake/stub" },
        this.usageDeltas,
      )
      if (entry) await this.opts.ledger.record(entry)
    }
    if (chunks.hangUntilInterrupt) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  /** Resolves when every prompt handed out so far — including released hangs — has fully settled. */
  settle(): Promise<unknown> {
    return this.tail
  }

  async interrupt(_role: AgentRole): Promise<void> {}
  async interruptAll(): Promise<void> {
    this.interruptAllCalls += 1
    this.release()
  }

  async close(): Promise<void> {
    this.release() // never leave a hung prompt dangling after the run ends
  }

  private release(): void {
    for (const release of this.waiters.splice(0)) release()
  }
}
