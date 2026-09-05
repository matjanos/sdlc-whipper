import type { AgentRole, PromptParts } from "../types.js"

export interface PromptOptions {
  /** Force a brand-new session for this role (reviewer rounds must not inherit anything). */
  fresh?: boolean
  /** Prompt tag used in session titles for ledger attribution. */
  tag?: string
}

export interface RunContext {
  runId: string
  ticket: string
  /** Worktree the agents operate in (undefined for batch phases like grooming). */
  worktree?: string
}

/**
 * Agent runtime port. Default adapter: OpenCode SDK embedded host. Sessions
 * are keyed by role per run: follow-up prompts reuse the same session
 * (executor keeps its context); `fresh: true` starts clean (reviewer rounds).
 */
export interface AgentRuntime {
  open(run: RunContext): Promise<void>

  prompt(role: AgentRole, parts: PromptParts, opts?: PromptOptions): Promise<string>

  /** Budget enforcement / kill switch for one role. Must be safe to call when no session exists. */
  interrupt(role: AgentRole): Promise<void>

  /** Kill every session in this run (budget exceeded). */
  interruptAll(): Promise<void>

  close(): Promise<void>
}
