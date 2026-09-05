import type { LedgerEntry } from "../types.js"

export type RollupKey = "ticket" | "phase" | "run" | "agent"

export interface RollupRow {
  key: string
  runs: number
  tokens: number
  costUsd: number
}

/**
 * Ledger port. Default adapter: local JSONL file + in-memory rollups. Records
 * every model call tagged with run/ticket/phase/agent for cost attribution.
 */
export interface LedgerStore {
  record(entry: LedgerEntry): Promise<void>

  rollup(by: RollupKey, filter?: { ticket?: string }): Promise<RollupRow[]>

  /** Current usage for a run — feeds Budget.assert(). */
  usage(runId: string): Promise<{ tokens: number; costUsd: number }>
}
