import type { IssueQuery, TicketTracker } from "../../ports/index.js"
import { parseSelector, type Selector } from "../../config.js"
import type { LogicalState, Ticket, TicketDraft, TrackerComment, WorkspaceMap } from "../../types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpToolbox } from "../mcp/client.js"

export interface LinearMcpOptions {
  team: string
  /** Optional project scope — passed server-side so project tickets are never crowded out of the first page. */
  project?: string
  map: Record<string, string>
  /** Remote MCP URL (default: official Linear MCP). */
  url?: string
  /** Bearer token; defaults LINEAR_MCP_TOKEN, then LINEAR_API_KEY. */
  token?: string
  /** Injectable transport (tests). */
  transport?: Transport
}

/** Upper bound on relation-state lookups per ticket, so a relation-heavy ticket cannot blow up a tick. */
const MAX_RELATION_LOOKUPS = 20

/**
 * Linear adapter speaking MCP instead of GraphQL. Same TicketTracker contract
 * as `tracker-linear`, selectable via `adapters.tracker: "linear-mcp"`.
 *
 * Shape drift, and how this adapter survives it:
 * - Tool names drift across server versions — every call resolves tools by
 *   candidate lists and failures name the actual catalog.
 * - Argument schemas drift too — the official server REJECTS unrecognized
 *   keys, so arguments are built per resolved tool name (never a bag of
 *   aliases). Tolerant/self-hosted servers keep working via their own entries.
 * - Response shapes drift — payloads are read through tolerant extractors,
 *   and relation entries that carry no state (official `get_issue`) are
 *   hydrated with bounded follow-up lookups so the conductor can tell a done
 *   blocker from a live one.
 */
export class LinearMcpTracker implements TicketTracker {
  private readonly tb: McpToolbox
  private ws?: WorkspaceMap
  private readonly tools = new Map<string, string>()

  constructor(private readonly opts: LinearMcpOptions) {
    const url = opts.url ?? process.env["LINEAR_MCP_URL"] ?? "https://mcp.linear.app/mcp"
    const token = opts.token ?? process.env["LINEAR_MCP_TOKEN"] ?? process.env["LINEAR_API_KEY"] ?? ""
    this.tb = new McpToolbox({ url, token, transport: opts.transport }, "linear-mcp")
    if (!token && !opts.transport) {
      throw new Error(
        "linear-mcp: no token — set LINEAR_MCP_TOKEN (or LINEAR_API_KEY; Linear MCP accepts API keys as bearer)",
      )
    }
  }

  /** Resolve a tool by purpose and call it with arguments shaped for that exact tool name. */
  private async call(
    purpose: string,
    candidates: string[],
    argsByName: Record<string, Record<string, unknown>>,
  ): Promise<unknown> {
    const name = await this.tool(purpose, candidates)
    const args = argsByName[name]
    if (!args) {
      throw new Error(
        `linear-mcp: tool "${name}" matched ${purpose} but no argument shape is known for it — ` +
          `add an entry to the candidates map (known: ${Object.keys(argsByName).join(", ")})`,
      )
    }
    return this.tb.callJson<unknown>(name, args)
  }

  private async tool(purpose: string, candidates: string[]): Promise<string> {
    const cached = this.tools.get(purpose)
    if (cached) return cached
    const name = await this.tb.findTool(candidates, purpose)
    this.tools.set(purpose, name)
    return name
  }

  async discoverWorkspace(): Promise<WorkspaceMap> {
    if (this.ws) return this.ws // one discovery per process; states/labels rarely change mid-run (restart to re-map)
    const raw = await this.call(
      "list statuses",
      ["list_issue_statuses", "list_workflow_statuses", "list_statuses"],
      {
        list_issue_statuses: { team: this.opts.team },
        list_workflow_statuses: { teamId: this.opts.team },
        list_statuses: { team: this.opts.team, teamId: this.opts.team },
      },
    )
    const statuses = extractNamedIds(raw)
    const ws: WorkspaceMap = { teamKey: this.opts.team, stateIds: {}, labelIds: {}, stateNameToLogical: {} }
    const problems: string[] = []

    for (const [logical, rawSel] of Object.entries(this.opts.map)) {
      const sel: Selector = parseSelector(rawSel, `tracker.map.${logical}`)
      if (sel.kind === "state") {
        const status = statuses.find((s) => s.name.toLowerCase() === sel.name.toLowerCase())
        if (!status) {
          problems.push(`state "${sel.name}" (for ${logical}) — available: ${statuses.map((s) => s.name).join(", ") || "(none)"}`)
          continue
        }
        ws.stateIds[logical as LogicalState] = status.id
        ws.stateNameToLogical[status.name] = logical as LogicalState
      }
    }

    // Labels are needed for `selected`/`needsInfo` markers; tolerate servers without a label-list tool.
    let labels: { id: string; name: string }[] = []
    try {
      const rawLabels = await this.call("list labels", ["list_issue_labels", "list_labels", "labels"], {
        list_issue_labels: { team: this.opts.team },
        list_labels: { team: this.opts.team, teamId: this.opts.team },
        labels: { team: this.opts.team, teamId: this.opts.team },
      })
      labels = extractNamedIds(rawLabels)
    } catch {
      /* label listing is optional at discovery time; addLabel/marking will surface a precise error later */
    }
    for (const label of labels) ws.labelIds[label.name] = label.id
    for (const [logical, rawSel] of Object.entries(this.opts.map)) {
      const sel: Selector = parseSelector(rawSel, `tracker.map.${logical}`)
      if (sel.kind === "label") {
        const entry = Object.entries(ws.labelIds).find(([name]) => name.toLowerCase() === sel.name.toLowerCase())
        if (!entry) problems.push(`label "${sel.name}" (for ${logical}) — not visible via MCP (create it in Linear or use the graphql adapter)`)
      }
    }

    if (problems.length) {
      throw new Error(`linear-mcp: workspace does not match config:\n  - ${problems.join("\n  - ")}`)
    }
    this.ws = ws
    return ws
  }

  private logicalFor(stateName: unknown): LogicalState {
    if (typeof stateName !== "string") return "backlog"
    if (!this.ws) return "backlog"
    for (const [name, logical] of Object.entries(this.ws.stateNameToLogical)) {
      if (name.toLowerCase() === stateName.toLowerCase()) return logical
    }
    return "backlog"
  }

  /** Concrete state name for a logical state (for servers that take names, not ids). */
  private stateNameFor(state: LogicalState): string | undefined {
    for (const [name, logical] of Object.entries(this.ws?.stateNameToLogical ?? {})) {
      if (logical === state) return name
    }
    return undefined
  }

  private normalizeIssue(raw: Record<string, unknown>): Ticket {
    const stateName =
      (raw["state"] as Record<string, unknown> | undefined)?.["name"] ??
      raw["stateName"] ??
      raw["status"]
    const labelsRaw = raw["labels"] as unknown
    const labels = Array.isArray(labelsRaw)
      ? labelsRaw.map((l) => (typeof l === "string" ? l : ((l as Record<string, unknown>)["name"] as string) ?? ""))
      : extractNodes(labelsRaw).map((l) => String(l["name"] ?? ""))
    const relations: Ticket["relations"] = [
      ...relationsFromGroups(raw["relations"]), // official get_issue: { blocks: [...], blockedBy: [...], relatedTo: [...] }
      ...extractNodes(raw["relations"]).map((r) => legacyRelation(r, this.logicalFor.bind(this))),
    ]
    const comments: TrackerComment[] = extractNodes(raw["comments"]).map(
      (c, i): TrackerComment => ({
        id: String(c["id"] ?? i),
        author: String(
          (c["user"] as Record<string, unknown> | undefined)?.["name"] ??
            (c["createdBy"] as Record<string, unknown> | undefined)?.["name"] ??
            c["userName"] ??
            "unknown",
        ),
        body: String(c["body"] ?? c["comment"] ?? ""),
        createdAt: String(c["createdAt"] ?? ""),
      }),
    )
    const project = raw["project"]
    return {
      key: String(raw["identifier"] ?? raw["key"] ?? raw["id"] ?? ""),
      url: raw["url"] ? String(raw["url"]) : undefined,
      title: String(raw["title"] ?? ""),
      description: String(raw["description"] ?? raw["descriptionText"] ?? ""),
      comments,
      labels: labels.filter(Boolean),
      state: this.logicalFor(stateName),
      relations,
      parentKey: (raw["parent"] as Record<string, unknown> | undefined)?.["identifier"]
        ? String((raw["parent"] as Record<string, unknown>)["identifier"])
        : typeof raw["parentId"] === "string"
          ? (raw["parentId"] as string)
          : undefined,
      projectName:
        typeof project === "string"
          ? project
          : (project as Record<string, unknown> | undefined)?.["name"]
            ? String((project as Record<string, unknown>)["name"])
            : undefined,
    }
  }

  private async fetchIssues(query: IssueQuery): Promise<Ticket[]> {
    await this.discoverWorkspace()
    const items = await this.listRaw({ ...query })
    const labelName = query.logicalLabel ? parseSelector(this.opts.map[query.logicalLabel] ?? "", "logicalLabel").name : undefined
    return items
      .filter((t) => (this.opts.project ? t.projectName === this.opts.project : true)) // server-side filter is best-effort across server versions
      .filter((t) => (labelName ? t.labels.some((l) => l.toLowerCase() === labelName.toLowerCase()) : true))
      .filter((t) => (query.state ? t.state === query.state : true))
      .filter((t) => (query.project ? t.projectName === query.project : true))
  }

  /** One page of issues, normalized. */
  private async listRaw(query: IssueQuery): Promise<Ticket[]> {
    const raw = (await this.call("list issues", ["list_issues", "search_issues", "issue_search"], {
      list_issues: {
        team: this.opts.team,
        ...(this.opts.project ? { project: this.opts.project } : {}),
        limit: 50,
      },
      search_issues: { team: this.opts.team, teamId: this.opts.team, first: 50, limit: 50, includeRelations: true },
      issue_search: { team: this.opts.team, teamId: this.opts.team, first: 50, limit: 50, includeRelations: true },
    })) as Record<string, unknown>
    return extractNodes(raw).map((n) => this.normalizeIssue(n))
  }

  async listIssues(query: IssueQuery): Promise<Ticket[]> {
    return this.fetchIssues(query)
  }

  /** Fetch one issue without hydration (no relation states, no comment merge). */
  private async getRaw(key: string): Promise<Ticket> {
    const raw = (await this.call("get issue", ["get_issue", "search_issue_by_id"], {
      get_issue: { id: key, includeRelations: true },
      search_issue_by_id: { issueId: key, issueIdOrKey: key, id: key },
    })) as Record<string, unknown>
    const node = (raw["issue"] as Record<string, unknown> | undefined) ?? raw
    const ticket = this.normalizeIssue(node)
    if (!ticket.key) ticket.key = key
    return ticket
  }

  /**
   * Full ticket: issue + relation states (official relation entries carry no
   * state; the conductor needs done-vs-blocking) + comments (official
   * get_issue omits them). Bounded: relation lookups are capped.
   */
  async getTicket(key: string): Promise<Ticket> {
    const ticket = await this.getRaw(key)
    let lookups = 0
    const seen = new Set<string>([ticket.key])
    for (const rel of ticket.relations) {
      if (!rel.key || seen.has(rel.key) || lookups >= MAX_RELATION_LOOKUPS) continue
      seen.add(rel.key)
      lookups++
      try {
        rel.state = (await this.getRaw(rel.key)).state
      } catch {
        /* leave the relation state as fetched; classification treats unknown as blocking */
      }
    }
    if (ticket.comments.length === 0 && (await this.tool("list comments", ["list_comments", "list_issue_comments"]).catch(() => null))) {
      const raw = await this.call("list comments", ["list_comments", "list_issue_comments"], {
        list_comments: { issueId: key, limit: 50 },
        list_issue_comments: { issueId: key, issueIdOrKey: key, id: key },
      })
      const issueNode = { comments: raw } as Record<string, unknown>
      ticket.comments = extractNodes(issueNode["comments"]).map(
        (c, i): TrackerComment => ({
          id: String(c["id"] ?? i),
          author: String(
            (c["user"] as Record<string, unknown> | undefined)?.["name"] ??
              (c["createdBy"] as Record<string, unknown> | undefined)?.["name"] ??
              c["userName"] ??
              "unknown",
          ),
          body: String(c["body"] ?? c["comment"] ?? ""),
          createdAt: String(c["createdAt"] ?? ""),
        }),
      )
    }
    return ticket
  }

  async comment(key: string, body: string, opts?: { editExistingTag?: string }): Promise<void> {
    if (opts?.editExistingTag) {
      if (await this.tool("list comments", ["list_comments", "list_issue_comments"]).catch(() => undefined)) {
        const raw = await this.call("list comments", ["list_comments", "list_issue_comments"], {
          list_comments: { issueId: key, limit: 50 },
          list_issue_comments: { issueId: key, issueIdOrKey: key, id: key },
        })
        const existing = extractNodes(raw).find((c) => String(c["body"] ?? "").includes(opts.editExistingTag!))
        if (existing) {
          await this.call("update comment", ["update_comment", "save_comment", "comment_update", "edit_comment"], {
            update_comment: { commentId: existing["id"], id: existing["id"], body },
            save_comment: { id: existing["id"], body },
            comment_update: { commentId: existing["id"], id: existing["id"], body },
            edit_comment: { commentId: existing["id"], id: existing["id"], body },
          })
          return
        }
      }
    }
    await this.call("create comment", ["create_comment", "save_comment", "comment_create", "add_comment"], {
      create_comment: { issueId: key, issueIdOrKey: key, id: key, body },
      save_comment: { issueId: key, body },
      comment_create: { issueId: key, issueIdOrKey: key, id: key, body },
      add_comment: { issueId: key, issueIdOrKey: key, id: key, body },
    })
  }

  async addLabel(key: string, labelName: string): Promise<void> {
    const addTool = await this.tool(
      "add label",
      ["save_issue", "add_label_to_issue", "issue_add_label", "add_label", "label_issue"],
    ).catch(() => undefined)
    if (addTool === "save_issue") {
      await this.tb.callJson(addTool, { id: key, addLabels: [labelName] })
      return
    }
    if (addTool) {
      const ws = this.ws ?? (await this.discoverWorkspace())
      const labelId = Object.entries(ws.labelIds).find(([name]) => name.toLowerCase() === labelName.toLowerCase())?.[1]
      await this.tb.callJson(addTool, { issueId: key, issueIdOrKey: key, id: key, labelId, label: labelId, name: labelName })
      return
    }
    // fall back to issue update with label ids/names
    const updateTool = await this.tool("update issue", ["update_issue", "issue_update", "edit_issue"])
    const ws = this.ws ?? (await this.discoverWorkspace())
    const labelId = Object.entries(ws.labelIds).find(([name]) => name.toLowerCase() === labelName.toLowerCase())?.[1]
    await this.tb.callJson(updateTool, {
      issueId: key,
      id: key,
      labelIds: labelId ? [labelId] : undefined,
      labels: labelId ? undefined : [labelName],
    })
  }

  async moveTo(key: string, state: LogicalState): Promise<void> {
    const ws = this.ws ?? (await this.discoverWorkspace())
    const resolved = await this.tool("update issue", ["save_issue", "update_issue", "issue_update", "edit_issue"])
    if (resolved === "save_issue") {
      // official server takes state type/name/id — pass the exact name resolved from this team
      await this.tb.callJson(resolved, { id: key, state: this.stateNameFor(state) ?? ws.stateIds[state] })
      return
    }
    const stateId = ws.stateIds[state]
    if (!stateId) throw new Error(`linear-mcp: no state mapped for logical "${state}"`)
    await this.tb.callJson(resolved, { issueId: key, issueIdOrKey: key, id: key, statusId: stateId, stateId })
  }

  async setRelation(key: string, kind: "blocks" | "blocked-by" | "relates", otherKey: string): Promise<void> {
    const type = kind === "blocked-by" ? "BLOCKED_BY" : kind === "blocks" ? "BLOCKS" : "RELATED"
    const relationKey = kind === "blocked-by" ? "blockedBy" : kind === "blocks" ? "blocks" : "relatedTo"
    await this.call(
      "create relation",
      ["save_issue", "create_issue_relation", "issue_relation_add", "add_issue_relation", "relate_issues", "create_relation"],
      {
        save_issue: { id: key, [relationKey]: [otherKey] },
        create_issue_relation: { issueId: key, id: key, relatedIssueId: otherKey, type },
        issue_relation_add: { issueId: key, id: key, relatedIssueId: otherKey, type },
        add_issue_relation: { issueId: key, id: key, relatedIssueId: otherKey, type },
        relate_issues: { issueId: key, id: key, relatedIssueId: otherKey, type },
        create_relation: { issueId: key, id: key, relatedIssueId: otherKey, type },
      },
    )
  }

  async createSubIssue(parentKey: string, draft: TicketDraft): Promise<Ticket> {
    const ticket = await this.createIssue(draft, parentKey)
    ticket.parentKey = parentKey
    return ticket
  }

  async createIssue(draft: TicketDraft, parentKey?: string): Promise<Ticket> {
    const raw = (await this.call("create issue", ["save_issue", "create_issue", "issue_create"], {
      save_issue: {
        team: this.opts.team,
        title: draft.title,
        description: draft.description,
        ...(this.opts.project ? { project: this.opts.project } : {}),
        ...(parentKey ? { parentId: parentKey } : {}),
      },
      create_issue: {
        team: this.opts.team,
        teamId: this.opts.team,
        title: draft.title,
        description: draft.description,
        ...(parentKey ? { parentId: parentKey, parentIssueId: parentKey } : {}),
      },
      issue_create: {
        team: this.opts.team,
        teamId: this.opts.team,
        title: draft.title,
        description: draft.description,
        ...(parentKey ? { parentId: parentKey, parentIssueId: parentKey } : {}),
      },
    })) as Record<string, unknown>
    const node = (raw["issue"] as Record<string, unknown> | undefined) ?? raw
    return this.normalizeIssue(node)
  }
}

/**
 * Official `get_issue` reports relations as grouped arrays of
 * `{ id, title }` with no state: `{ blocks: [...], blockedBy: [...],
 * relatedTo: [...], duplicateOf }`. States are hydrated by getTicket.
 */
function relationsFromGroups(raw: unknown): Ticket["relations"] {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return []
  const groups = raw as Record<string, unknown>
  const kindFor: Record<string, "blocks" | "blocked-by" | "relates"> = {
    blocks: "blocks",
    blockedBy: "blocked-by",
    relatedTo: "relates",
  }
  const out: Ticket["relations"] = []
  for (const [group, kind] of Object.entries(kindFor)) {
    const entries = groups[group]
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue
      const e = entry as Record<string, unknown>
      const key = String(e["id"] ?? e["identifier"] ?? "")
      if (!key) continue
      out.push({ kind, key, state: "backlog" })
    }
  }
  return out
}

/** Legacy flat relation nodes: `{ type: "BLOCKS", issue: { identifier, state } }`. */
function legacyRelation(
  r: Record<string, unknown>,
  logicalFor: (stateName: unknown) => LogicalState,
): Ticket["relations"][number] {
  const kindMap: Record<string, "blocks" | "blocked-by" | "relates"> = {
    BLOCKS: "blocks",
    blocks: "blocks",
    BLOCKED_BY: "blocked-by",
    blocked_by: "blocked-by",
    RELATED: "relates",
    related: "relates",
  }
  const issue = (r["issue"] ?? r["relatedIssue"]) as Record<string, unknown> | undefined
  return {
    kind: kindMap[String(r["type"] ?? "")] ?? "relates",
    key: String(issue?.["identifier"] ?? r["identifier"] ?? ""),
    state: logicalFor(issue?.["state"]),
  }
}

/** Tolerant extraction of node lists from the shapes Linear MCP tools return. */
function extractNodes(raw: unknown): Record<string, unknown>[] {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>
    for (const key of ["nodes", "items", "results", "issues", "data", "comments", "labels", "issueStatuses", "statuses", "relations", "edges"]) {
      const value = obj[key]
      if (Array.isArray(value)) return value.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
      if (value && typeof value === "object") {
        const nested = extractNodes(value)
        if (nested.length) return nested
      }
    }
    // a single object result (e.g. one issue)
    if ("identifier" in obj || "title" in obj || "id" in obj) return [obj]
  }
  return []
}

function extractNamedIds(raw: unknown): { id: string; name: string }[] {
  return extractNodes(raw)
    .map((n) => ({ id: String(n["id"] ?? n["name"] ?? ""), name: String(n["name"] ?? n["label"] ?? "") }))
    .filter((x) => x.id && x.name)
}
