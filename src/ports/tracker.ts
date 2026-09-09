import type {
  LogicalState,
  Ticket,
  TicketDraft,
  WorkspaceMap,
} from "../types.js"

export interface IssueQuery {
  /** Only tickets carrying this logical marker (e.g. `selected`). */
  logicalLabel?: string
  /** Only tickets currently in this logical state. */
  state?: LogicalState
  /** Only tickets under this release batch (tracker project) name. */
  project?: string
}

/**
 * Ticket tracker port. Default adapter: Linear. The core never learns whether
 * it is talking to Linear or Jira — logical states/labels only, mapped in
 * `.whipper/config.json`.
 */
export interface TicketTracker {
  /** Resolve configured state/label selectors against the live workspace. Throws with a helpful message on unmapped names. */
  discoverWorkspace(): Promise<WorkspaceMap>

  listIssues(query: IssueQuery): Promise<Ticket[]>

  getTicket(key: string): Promise<Ticket>

  /** Create or edit (editExistingTag) a comment. Used for escalation threads. */
  comment(key: string, body: string, opts?: { editExistingTag?: string }): Promise<void>

  addLabel(key: string, labelName: string): Promise<void>

  moveTo(key: string, state: LogicalState): Promise<void>

  setRelation(
    key: string,
    kind: "blocks" | "blocked-by" | "relates",
    otherKey: string,
  ): Promise<void>

  createSubIssue(parentKey: string, draft: TicketDraft): Promise<Ticket>

  /** Future: observability intake. */
  createIssue(draft: TicketDraft): Promise<Ticket>
}
