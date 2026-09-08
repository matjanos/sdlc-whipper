/**
 * Core domain types. The conductor core speaks ONLY these shapes — never a
 * vendor's. Adapters (linear, github, vercel, opencode) translate to/from
 * their native APIs and must not leak vendor types past their boundary.
 */

export type AgentRole =
  | "groomer"
  | "split"
  | "researcher"
  | "council"
  | "executor"
  | "reviewer"
  | "tester"

export type PhaseName =
  | "groom"
  | "split"
  | "research"
  | "council"
  | "execute"
  | "review"
  | "publish"
  | "await-preview"
  | "test"

/** Logical workflow states. Concrete tracker states map onto these in config. */
export type LogicalState =
  | "backlog"
  | "selected"
  | "inProgress"
  | "inReview"
  | "done"
  | "cancelled"

/** Human-readable state names for logs and escalation comments. */
export const LOGICAL_STATE_LABEL: Record<LogicalState, string> = {
  backlog: "Backlog",
  selected: "Selected for delivery",
  inProgress: "In progress",
  inReview: "In review",
  done: "Done",
  cancelled: "Cancelled",
}

export interface TrackerComment {
  id: string
  author: string
  body: string
  createdAt: string
}

export interface TicketRelation {
  kind: "blocks" | "blocked-by" | "relates"
  /** Human key of the related ticket, e.g. "LIN-123". */
  key: string
  state: LogicalState
}

export interface Ticket {
  /** Human key, e.g. "LIN-123" (normalized; adapters keep the native id internally). */
  key: string
  url?: string
  title: string
  description: string
  comments: TrackerComment[]
  /** Concrete label names as they appear in the tracker. */
  labels: string[]
  state: LogicalState
  relations: TicketRelation[]
  parentKey?: string
  projectName?: string
}

export interface TicketDraft {
  title: string
  description: string
  labels?: string[]
  parentKey?: string
}

export interface PullRequest {
  number: number
  url: string
  headRef: string
  baseRef: string
  state: "open" | "closed" | "merged"
  checks: CheckStatus
  reviewDecision?: "approved" | "changes_requested" | "none"
}

export interface CheckStatus {
  status: "pending" | "pass" | "fail" | "unknown"
  summary: string
}

export interface PreviewRef {
  url: string
  status: "building" | "ready" | "error"
}

/** What a phase hands to the agent runtime. Assembled in exactly one place per phase. */
export interface PromptParts {
  text: string
  /** Absolute file paths the runtime may attach as context (e.g. plan.md for the executor). */
  attachFiles?: string[]
}

export interface LedgerEntry {
  runId: string
  ticket: string
  phase: PhaseName | "tick"
  agent: AgentRole | "conductor"
  model?: string
  ts: string
  tokens: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }
  /** null when pricing is unavailable — rollups then report tokens only. */
  costUsd: number | null
  sessionId?: string
}

export interface WorkspaceMap {
  teamKey: string
  /** logical state name → concrete tracker state id */
  stateIds: Partial<Record<LogicalState, string>>
  /** concrete label name → label id */
  labelIds: Record<string, string>
  /** concrete state name → logical state (inverse resolution for normalizing fetched tickets) */
  stateNameToLogical: Record<string, LogicalState>
}

/** Terminal, expected flow-control errors the runner understands. */
export class EscalationError extends Error {
  constructor(
    public tag: EscalationTag,
    public body: string,
  ) {
    super(`escalation:${tag}: ${body}`)
    this.name = "EscalationError"
  }
}

export class BudgetExceededError extends Error {
  constructor(
    public usage: { tokens: number; costUsd: number },
    public caps: { tokens: number; costUsd: number },
  ) {
    super(
      `budget exceeded: $${usage.costUsd.toFixed(2)}/${caps.costUsd} or ${usage.tokens}/${caps.tokens} tokens`,
    )
    this.name = "BudgetExceededError"
  }
}

export type EscalationTag =
  | "needs-info"
  | "stalemate"
  | "budget-exceeded"
  | "phase-error"
  | "test-failed"
  | "provider-rate-limit"

/**
 * The assistant message exists but carries a provider error — terminal for
 * this attempt. Domain-level (not vendor): the conductor maps rate limits to
 * a parked escalation, everything else to a phase failure.
 */
export class ModelCallFailedError extends Error {
  constructor(detail: string) {
    super(`model call failed inside the session — ${detail}`)
    this.name = "ModelCallFailedError"
  }
}

export type RunStatus =
  | "delivered"
  | "escalated"
  | "parked"
  | "failed"
  | "dry-run"

export interface RunState {
  runId: string
  ticket: string
  status: RunStatus
  startedAt: string
  updatedAt: string
  prNumber?: number
  previewUrl?: string
  phaseReached: PhaseName | "tick"
  message?: string
}
