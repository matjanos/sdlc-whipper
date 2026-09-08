import type { IssueQuery, TicketTracker } from "../../ports/index.js"
import type { LogicalState, Ticket, TicketDraft, WorkspaceMap } from "../../types.js"
import { existsSync, readFileSync } from "node:fs"

/** Optional seed for the fake adapter: SDL_FAKE_TICKETS=/path/to/tickets.json (offline demos). */
function seedFromEnv(): Ticket[] {
  const file = process.env["SDL_FAKE_TICKETS"]
  if (!file || !existsSync(file)) return []
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Ticket[]
  } catch {
    return []
  }
}

export interface FakeTrackerOptions {
  /** Pre-seeded tickets. */
  tickets?: Ticket[]
  /** Logical → selector map, same semantics as config; defaults use plain names so seeds stay readable. */
  map?: Record<string, string>
  /** Record every mutation for assertions (and [dry-run] honesty checks in tests). */
  calls?: { op: string; args: unknown[] }[]
}

/**
 * In-memory tracker. Doubles as: (a) the test double for the conductor core,
 * (b) the `fake` adapter for fully offline demo runs
 * (`--tracker fake`), and (c) the reference implementation of the
 * TicketTracker contract (contract tests run against it).
 */
export class FakeTracker implements TicketTracker {
  private tickets: Map<string, Ticket>
  private labelSeq = 1
  private commentSeq = 1
  private issueSeq: number
  private readonly map: Record<string, string>
  readonly workspace: WorkspaceMap
  readonly calls: { op: string; args: unknown[] }[]

  constructor(opts: FakeTrackerOptions = {}) {
    this.tickets = new Map((opts.tickets ?? seedFromEnv()).map((t) => [t.key, structuredClone(t)]))
    this.calls = opts.calls ?? []
    this.map = opts.map ?? {
      selected: "label:selected",
      needsInfo: "label:needs-info",
      inProgress: "state:In Progress",
      inReview: "state:In Review",
      done: "state:Done",
      cancelled: "state:Canceled",
    }
    this.issueSeq = this.tickets.size + 100
    this.workspace = {
      teamKey: "FAKE",
      stateIds: {},
      labelIds: {},
      stateNameToLogical: {
        Backlog: "backlog",
        Selected: "selected",
        "In Progress": "inProgress",
        "In Review": "inReview",
        Done: "done",
        Canceled: "cancelled",
      },
    }
    for (const [name, logical] of Object.entries(this.workspace.stateNameToLogical)) {
      this.workspace.stateIds[logical] = `state_${name}`
    }
  }

  private record(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args })
  }

  async discoverWorkspace(): Promise<WorkspaceMap> {
    this.record("discoverWorkspace")
    return this.workspace
  }

  async listIssues(query: IssueQuery): Promise<Ticket[]> {
    this.record("listIssues", query)
    // translate the logical marker to this tracker's concrete label name, like real adapters do
    const labelName = query.logicalLabel
      ? (() => {
          const raw = this.map[query.logicalLabel!]
          const idx = raw?.indexOf(":") ?? -1
          return idx > 0 ? raw!.slice(idx + 1) : raw
        })()
      : undefined
    const all = [...this.tickets.values()]
    return all
      .filter((t) => (labelName ? t.labels.includes(labelName) : true))
      .filter((t) => (query.state ? t.state === query.state : true))
      .filter((t) => (query.project ? t.projectName === query.project : true))
      .map((t) => structuredClone(t))
  }

  async getTicket(key: string): Promise<Ticket> {
    this.record("getTicket", key)
    const t = this.tickets.get(key)
    if (!t) throw new Error(`fake tracker: no ticket ${key}`)
    return structuredClone(t)
  }

  async comment(key: string, body: string, opts?: { editExistingTag?: string }): Promise<void> {
    this.record("comment", key, body, opts)
    const t = this.mustGet(key)
    if (opts?.editExistingTag) {
      const existing = t.comments.find((c) => c.body.includes(opts.editExistingTag!))
      if (existing) {
        existing.body = body
        return
      }
    }
    t.comments.push({
      id: `c${this.commentSeq++}`,
      author: "sdlc-whipper",
      body,
      createdAt: new Date().toISOString(),
    })
  }

  async addLabel(key: string, labelName: string): Promise<void> {
    this.record("addLabel", key, labelName)
    const t = this.mustGet(key)
    if (!t.labels.includes(labelName)) t.labels.push(labelName)
    this.workspace.labelIds[labelName] ??= `label_${this.labelSeq++}`
  }

  async moveTo(key: string, state: LogicalState): Promise<void> {
    this.record("moveTo", key, state)
    this.mustGet(key).state = state
  }

  async setRelation(
    key: string,
    kind: "blocks" | "blocked-by" | "relates",
    otherKey: string,
  ): Promise<void> {
    this.record("setRelation", key, kind, otherKey)
    const other = this.mustGet(otherKey)
    this.mustGet(key).relations.push({ kind, key: otherKey, state: other.state })
  }

  async createSubIssue(parentKey: string, draft: TicketDraft): Promise<Ticket> {
    this.record("createSubIssue", parentKey, draft)
    const parent = this.mustGet(parentKey)
    const ticket: Ticket = {
      key: `FAKE-${this.issueSeq++}`,
      title: draft.title,
      description: draft.description,
      comments: [],
      labels: draft.labels ? [...draft.labels] : [],
      state: "backlog",
      relations: [],
      parentKey: parent.key,
      projectName: parent.projectName,
    }
    this.tickets.set(ticket.key, ticket)
    return structuredClone(ticket)
  }

  async createIssue(draft: TicketDraft): Promise<Ticket> {
    this.record("createIssue", draft)
    const ticket: Ticket = {
      key: `FAKE-${this.issueSeq++}`,
      title: draft.title,
      description: draft.description,
      comments: [],
      labels: draft.labels ? [...draft.labels] : [],
      state: "backlog",
      relations: [],
    }
    this.tickets.set(ticket.key, ticket)
    return structuredClone(ticket)
  }

  private mustGet(key: string): Ticket {
    const t = this.tickets.get(key)
    if (!t) throw new Error(`fake tracker: no ticket ${key}`)
    return t
  }
}
