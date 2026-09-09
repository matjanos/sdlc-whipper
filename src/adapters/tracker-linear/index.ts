import type { IssueQuery, TicketTracker } from "../../ports/index.js"
import { parseSelector, type Selector } from "../../config.js"
import type { LogicalState, Ticket, TicketDraft, WorkspaceMap } from "../../types.js"

const API = "https://api.linear.app/graphql"

interface LinearIssueRaw {
  id: string
  identifier: string
  title: string
  url?: string
  description?: string
  state?: { name: string } | null
  labels?: { nodes: { name: string }[] } | null
  relations?: { nodes: { type: string; issue: { identifier: string; state?: { name: string } | null } }[] } | null
  parent?: { identifier: string } | null
  project?: { name: string } | null
  comments?: { nodes: { id: string; body: string; user?: { name: string } | null; createdAt: string }[] } | null
}

const ISSUE_FIELDS = `
  id identifier title url description
  state { name }
  labels(first: 20) { nodes { name } }
  relations(first: 20) { nodes { type issue { identifier state { name } } } }
  parent { identifier }
  project { name }
`

interface IssuesPage {
  issues: {
    nodes: LinearIssueRaw[]
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

export interface LinearOptions {
  apiKey?: string
  /** Team key from config (e.g. "LIN"). */
  team: string
  /** Logical marker → selector map from config (e.g. { selected: "label:sdlc-selected", ... }). */
  map: Record<string, string>
}

interface GqlError extends Error {
  response?: unknown
}

/**
 * Linear adapter for the TicketTracker port. Speaks logical states/labels
 * only; concrete names come from `.whipper/config.json` and are validated against
 * the live workspace on every discovery.
 */
export class LinearTracker implements TicketTracker {
  private readonly apiKey: string
  private ws?: WorkspaceMap
  private teamId?: string
  private readonly idCache = new Map<string, string>()

  constructor(private readonly opts: LinearOptions) {
    this.apiKey = opts.apiKey ?? process.env["LINEAR_API_KEY"] ?? ""
    if (!this.apiKey) {
      throw new Error("Linear adapter: LINEAR_API_KEY is missing (set it in the environment or .env)")
    }
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response
    try {
      res = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
      })
    } catch (err) {
      throw new Error(`Linear API unreachable: ${(err as Error).message}`)
    }
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] }
    if (!res.ok || body.errors?.length) {
      const messages = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`
      const err = new Error(`Linear API error: ${messages}`) as GqlError
      err.response = body
      throw err
    }
    return body.data as T
  }

  private async requireTeamId(): Promise<string> {
    if (this.teamId) return this.teamId
    const data = await this.gql<{ team: { id: string } | null }>(
      `query($key: String!) { team(id: $key) { id } }`,
      { key: this.opts.team },
    )
    if (!data.team) {
      throw new Error(`Linear adapter: team "${this.opts.team}" not found — check tracker.team in config`)
    }
    this.teamId = data.team.id
    return this.teamId
  }

  async discoverWorkspace(): Promise<WorkspaceMap> {
    const teamKey = this.opts.team
    const data = await this.gql<{
      team: {
        id: string
        key: string
        states: { nodes: { id: string; name: string }[] }
        labels: { nodes: { id: string; name: string }[] }
      } | null
    }>(
      `query($key: String!) {
        team(id: $key) {
          id key
          states(first: 50) { nodes { id name } }
          labels(first: 100) { nodes { id name } }
        }
      }`,
      { key: teamKey },
    )
    if (!data.team) {
      throw new Error(`Linear adapter: team "${teamKey}" not found — check tracker.team in config`)
    }
    this.teamId = data.team.id
    const statesByName = new Map(data.team.states.nodes.map((s) => [s.name, s]))
    const labelsByName = new Map(data.team.labels.nodes.map((l) => [l.name, l]))

    const ws: WorkspaceMap = {
      teamKey: data.team.key,
      stateIds: {},
      labelIds: {},
      stateNameToLogical: {},
    }
    const problems: string[] = []
    for (const [logical, raw] of Object.entries(this.opts.map)) {
      const sel: Selector = parseSelector(raw, `tracker.map.${logical}`)
      if (sel.kind === "state") {
        const state = statesByName.get(sel.name)
        if (!state) {
          problems.push(`state "${sel.name}" (for ${logical}) — available: ${[...statesByName.keys()].join(", ")}`)
          continue
        }
        ws.stateIds[logical as LogicalState] = state.id
        ws.stateNameToLogical[state.name] = logical as LogicalState
      } else {
        const label = labelsByName.get(sel.name)
        if (!label) {
          problems.push(`label "${sel.name}" (for ${logical}) — available: ${[...labelsByName.keys()].join(", ") || "(none)"}`)
          continue
        }
        ws.labelIds[label.name] = label.id
      }
    }
    if (problems.length) {
      throw new Error(
        `Linear workspace does not match config (team ${data.team.key}):\n  - ${problems.join("\n  - ")}\n` +
          "Fix the names in tracker.map or create the missing labels/states in Linear.",
      )
    }
    this.ws = ws
    return ws
  }

  private logicalFor(stateName: string | undefined): LogicalState {
    if (!stateName) return "backlog"
    return this.ws?.stateNameToLogical[stateName] ?? "backlog"
  }

  private normalize(raw: LinearIssueRaw): Ticket {
    const kindMap: Record<string, "blocks" | "blocked-by" | "relates"> = {
      BLOCKS: "blocks",
      BLOCKED_BY: "blocked-by",
      RELATED: "relates",
      RELATED_TO: "relates",
      DUPLICATE: "relates",
    }
    this.idCache.set(raw.identifier, raw.id)
    return {
      key: raw.identifier,
      url: raw.url,
      title: raw.title,
      description: raw.description ?? "",
      comments: (raw.comments?.nodes ?? []).map((c) => ({
        id: c.id,
        author: c.user?.name ?? "unknown",
        body: c.body,
        createdAt: c.createdAt,
      })),
      labels: raw.labels?.nodes.map((l) => l.name) ?? [],
      state: this.logicalFor(raw.state?.name),
      relations: (raw.relations?.nodes ?? []).map((r) => ({
        kind: kindMap[r.type] ?? "relates",
        key: r.issue.identifier,
        state: this.logicalFor(r.issue.state?.name),
      })),
      parentKey: raw.parent?.identifier,
      projectName: raw.project?.name ?? undefined,
    }
  }

  async listIssues(query: IssueQuery): Promise<Ticket[]> {
    const teamId = await this.requireTeamId()
    const selected: Ticket[] = []
    let after: string | null = null
    for (let page = 0; page < 5; page++) {
      const data: IssuesPage = await this.gql<IssuesPage>(
        `query($teamId: String!, $after: String) {
          issues(first: 50, after: $after, filter: { team: { id: { eq: $teamId } } }, orderBy: updatedAt) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { teamId, after },
      )
      selected.push(...data.issues.nodes.map((n: LinearIssueRaw) => this.normalize(n)))
      if (!data.issues.pageInfo.hasNextPage) break
      after = data.issues.pageInfo.endCursor
    }
    const labelName = query.logicalLabel ? this.labelNameFor(query.logicalLabel) : undefined
    return selected
      .filter((t) => (labelName ? t.labels.includes(labelName) : true))
      .filter((t) => (query.state ? t.state === query.state : true))
      .filter((t) => (query.project ? t.projectName === query.project : true))
  }

  private labelNameFor(logical: string): string {
    const raw = this.opts.map[logical]
    if (!raw) throw new Error(`Linear adapter: no config mapping for logical label "${logical}"`)
    return parseSelector(raw, `tracker.map.${logical}`).name
  }

  private async issueId(key: string): Promise<string> {
    const cached = this.idCache.get(key)
    if (cached) return cached
    const data = await this.gql<{ issue: { id: string } | null }>(`query($key: String!) { issue(id: $key) { id } }`, {
      key,
    })
    if (!data.issue) throw new Error(`Linear adapter: issue ${key} not found`)
    this.idCache.set(key, data.issue.id)
    return data.issue.id
  }

  async getTicket(key: string): Promise<Ticket> {
    const data = await this.gql<{ issue: LinearIssueRaw | null }>(
      `query($key: String!) {
        issue(id: $key) {
          ${ISSUE_FIELDS}
          comments(first: 50) { nodes { id body user { name } createdAt } }
        }
      }`,
      { key },
    )
    if (!data.issue) throw new Error(`Linear adapter: issue ${key} not found`)
    return this.normalize(data.issue)
  }

  async comment(key: string, body: string, opts?: { editExistingTag?: string }): Promise<void> {
    const issueId = await this.issueId(key)
    if (opts?.editExistingTag) {
      const data = await this.gql<{ issue: { comments: { nodes: { id: string; body: string }[] } | null } | null }>(
        `query($key: String!) { issue(id: $key) { comments(first: 100) { nodes { id body } } } }`,
        { key },
      )
      const existing = data.issue?.comments?.nodes.find((c) => c.body.includes(opts.editExistingTag!))
      if (existing) {
        await this.gql(`mutation($id: String!, $body: String!) { commentUpdate(id: $id, input: { body: $body }) { success } }`, {
          id: existing.id,
          body,
        })
        return
      }
    }
    await this.gql(
      `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
      { issueId, body },
    )
  }

  async addLabel(key: string, labelName: string): Promise<void> {
    const ws = this.ws ?? (await this.discoverWorkspace())
    const labelId = ws.labelIds[labelName]
    if (!labelId) {
      throw new Error(
        `Linear adapter: label "${labelName}" not found in team ${ws.teamKey} — create it or fix tracker.map`,
      )
    }
    const issueId = await this.issueId(key)
    await this.gql(
      `mutation($issueId: String!, $labelId: String!) { issueLabelAdd(input: { issueId: $issueId, labelId: $labelId }) { success } }`,
      { issueId, labelId },
    )
  }

  async moveTo(key: string, state: LogicalState): Promise<void> {
    const ws = this.ws ?? (await this.discoverWorkspace())
    const stateId = ws.stateIds[state]
    if (!stateId) throw new Error(`Linear adapter: no state mapped for logical "${state}" — fix tracker.map`)
    const issueId = await this.issueId(key)
    await this.gql(`mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`, {
      id: issueId,
      stateId,
    })
  }

  async setRelation(
    key: string,
    kind: "blocks" | "blocked-by" | "relates",
    otherKey: string,
  ): Promise<void> {
    const type = kind === "blocked-by" ? "BLOCKED_BY" : kind === "blocks" ? "BLOCKS" : "RELATED"
    const issueId = await this.issueId(key)
    const relatedIssueId = await this.issueId(otherKey)
    await this.gql(
      `mutation($issueId: String!, $relatedIssueId: String!, $type: IssueRelationType!) {
        issueRelationAdd(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) { success }
      }`,
      { issueId, relatedIssueId, type },
    )
  }

  async createSubIssue(parentKey: string, draft: TicketDraft): Promise<Ticket> {
    const teamId = await this.requireTeamId()
    const parentId = await this.issueId(parentKey)
    const ws = this.ws ?? (await this.discoverWorkspace())
    const labelIds = (draft.labels ?? [])
      .map((name) => ws.labelIds[name])
      .filter((id): id is string => Boolean(id))
    const data = await this.gql<{ issueCreate: { issue: LinearIssueRaw | null } }>(
      `mutation($teamId: String!, $title: String!, $description: String!, $parentId: String!, $labelIds: [String!]) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, parentId: $parentId, labelIds: $labelIds }) {
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { teamId, title: draft.title, description: draft.description, parentId, labelIds },
    )
    if (!data.issueCreate.issue) throw new Error("Linear adapter: sub-issue creation returned no issue")
    return this.normalize(data.issueCreate.issue)
  }

  async createIssue(draft: TicketDraft): Promise<Ticket> {
    const teamId = await this.requireTeamId()
    const ws = this.ws ?? (await this.discoverWorkspace())
    const labelIds = (draft.labels ?? [])
      .map((name) => ws.labelIds[name])
      .filter((id): id is string => Boolean(id))
    const data = await this.gql<{ issueCreate: { issue: LinearIssueRaw | null } }>(
      `mutation($teamId: String!, $title: String!, $description: String!, $labelIds: [String!]) {
        issueCreate(input: { teamId: $teamId, title: $title, description: $description, labelIds: $labelIds }) {
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { teamId, title: draft.title, description: draft.description, labelIds },
    )
    if (!data.issueCreate.issue) throw new Error("Linear adapter: issue creation returned no issue")
    return this.normalize(data.issueCreate.issue)
  }
}
