import type { AgentRuntime, PromptOptions, RunContext } from "../../ports/index.js"
import type { LedgerStore } from "../../ports/index.js"
import type { AgentRole, PromptParts } from "../../types.js"

export interface FakeRuntimeOptions {
  /** Per-role scripted outputs (consumed in order; falls back to defaults). An Error entry is thrown — for provider-failure paths. */
  script?: Partial<Record<AgentRole, (string | Error)[]>>
  /** Multiply emitted token counts — makes budget-exceeded paths testable. */
  tokenBoost?: number
  ledger?: LedgerStore
  /** Every prompt, in order — the firewall tests assert against these. */
  prompts?: { role: AgentRole; text: string }[]
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
  }

  async prompt(role: AgentRole, parts: PromptParts, _opts?: PromptOptions): Promise<string> {
    this.prompts.push({ role, text: parts.text })
    const queue = this.queue[role]
    const output = queue?.shift() ?? DEFAULTS[role]!
    if (output instanceof Error) throw output
    if (this.opts.ledger && this.run) {
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

  async interrupt(_role: AgentRole): Promise<void> {}
  async interruptAll(): Promise<void> {}
  async close(): Promise<void> {}
}
