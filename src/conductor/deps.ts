import type { ResolvedConfig } from "../config.js"
import type { Artifacts } from "./artifacts.js"
import type { Budget } from "./budget.js"
import type { Logger } from "../util/log.js"
import type { Ticket } from "../types.js"
import type {
  AgentRuntime,
  CodeHost,
  LedgerStore,
  PreviewEnvironment,
  TicketTracker,
} from "../ports/index.js"

/** Everything a phase may touch. Phases never construct anything — they receive deps. */
export interface ConductorDeps {
  config: ResolvedConfig
  tracker: TicketTracker
  codehost: CodeHost
  preview: PreviewEnvironment
  runtime: AgentRuntime
  ledger: LedgerStore
  budget: Budget
  log: Logger
  dryRun: boolean
}

export interface TaskContext {
  ticket: Ticket
  /** Worktree for code phases; undefined for batch phases (grooming). */
  worktree: string | undefined
  artifacts: Artifacts
  deps: ConductorDeps
  /** Identifies this delivery in the ledger/budget. */
  runId: string
}

/** Results keyed by phase name, threaded through the pipeline. */
export type Outcomes = Record<string, unknown>
