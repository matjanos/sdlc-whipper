import type { LedgerStore } from "../ports/index.js"
import { BudgetExceededError } from "../types.js"

export interface BudgetCaps {
  tokens: number
  costUsd: number
}

/**
 * Per-task budget. Enforced in conductor code before every LLM prompt — the
 * agents never get to decide whether they are too expensive.
 */
export class Budget {
  constructor(
    private readonly caps: BudgetCaps,
    private readonly ledger: LedgerStore,
  ) {}

  async assert(runId: string): Promise<void> {
    const usage = await this.ledger.usage(runId)
    if (usage.tokens > this.caps.tokens || usage.costUsd > this.caps.costUsd) {
      throw new BudgetExceededError(usage, this.caps)
    }
  }
}
