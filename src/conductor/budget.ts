import type { LedgerStore } from "../ports/index.js"
import { BudgetExceededError } from "../types.js"

export interface BudgetCaps {
  tokens: number
  costUsd: number
}

/** Fraction of a cap at which the run is loudly warned about (once per run). */
const WARN_AT = 0.8

export interface AssertOptions {
  /** Called at most once per runId, when usage first crosses 80% of either cap. */
  onWarning?: (message: string) => void
}

/**
 * Per-task budget. Enforced in conductor code before every LLM prompt — the
 * agents never get to decide whether they are too expensive. The crossing of
 * 80% of either cap is surfaced through `onWarning` so the timeline can show
 * the burn before the hard stop.
 */
export class Budget {
  private readonly warned = new Set<string>()

  constructor(
    private readonly caps: BudgetCaps,
    private readonly ledger: LedgerStore,
  ) {}

  async assert(runId: string, opts?: AssertOptions): Promise<void> {
    const usage = await this.ledger.usage(runId)
    if (usage.tokens > this.caps.tokens || usage.costUsd > this.caps.costUsd) {
      throw new BudgetExceededError(usage, this.caps)
    }
    if (!opts?.onWarning || this.warned.has(runId)) return
    const byTokens = usage.tokens / this.caps.tokens
    const byCost = this.caps.costUsd > 0 ? usage.costUsd / this.caps.costUsd : 0
    const worst = Math.max(byTokens, byCost)
    if (worst < WARN_AT) return
    this.warned.add(runId)
    opts.onWarning(
      `budget warning: ${Math.round(worst * 100)}% of the per-task cap used ` +
        `($${usage.costUsd.toFixed(2)}/${this.caps.costUsd}, ${usage.tokens}/${this.caps.tokens} tokens)`,
    )
  }
}
