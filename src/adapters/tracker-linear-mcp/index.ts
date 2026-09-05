import type { IssueQuery, TicketTracker } from "../../ports/index.js"
import { parseSelector, type Selector } from "../../config.js"
import type { LogicalState, Ticket, TicketDraft, TrackerComment, WorkspaceMap } from "../../types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { McpToolbox } from "../mcp/client.js"

export interface LinearMcpOptions {
  team: string
  map: Record<string, string>
  /** Remote MCP URL (default: official Linear MCP). */
  url?: string
  /** Bearer token; defaults LINEAR_MCP_TOKEN, then LINEAR_API_KEY. */
  token?: string
  /** Injectable transport (tests). */
  transport?: Transport
}

/**
 * Linear adapter speaking MCP instead of GraphQL. Same TicketTracker contract
 * as `tracker-linear`, selectable via `adapters.tracker: "linear-mcp"`.
 * Useful when you want one auth story (Linear MCP) for both the agents and
 * the conductor. Tool names/args drift across MCP server versions, so every
 * call resolves tools by candidates and passes argument aliases; failures
 * name the available tools so fixes are obvious.
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

  private async tool(purpose: string, candidates: string[]): Promise<string> {
    const cached = this.tools.get(purpose)
    if (cached) return cached
    const name = await this.tb.findTool(candidates, purpose)
    this.tools.set(purpose, name)
    return name
  }

  async discoverWorkspace(): Promise<WorkspaceMap> {
    const statusesTool = await this.tool("list statuses", ["list_issue_statuses", "list_workflow_statuses", "list_statuses"])
    const raw = await this.tb.callJson<unknown>(statusesTool, { team: this.opts.team, teamId: this.opts.team })
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
    const labelsTool = await this.tool("list labels", ["list_labels", "list_issue_labels", "labels"])
      .catch(() => undefined)
    if (labelsTool) {
      const rawLabels = await this.tb.callJson<unknown>(labelsTool, { team: this.opts.team, teamId: this.opts.team })
      for (const label of extractNamedIds(rawLabels)) ws.labelIds[label.name] = label.id
    }
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

  private normalizeIssue(raw: Record<string, unknown>): Ticket {
    const stateName =
      (raw["state"] as Record<string, unknown> | undefined)?.["name"] ??
      raw["stateName"] ??
      raw["status"]
    const labelsRaw = raw["labels"] as unknown
    const labels = Array.isArray(labelsRaw)
      ? labelsRaw.map((l) => (typeof l === "string" ? l : ((l as Record<string, unknown>)["name"] as string) ?? ""))
      : extractNodes(labelsRaw).map((l) => String(l["name"] ?? ""))
    const relationsRaw = extractNodes(raw["relations"])
    const kindMap: Record<string, "blocks" | "blocked-by" | "relates"> = {
      BLOCKS: "blocks",
      blocks: "blocks",
      BLOCKED_BY: "blocked-by",
      blocked_by: "blocked-by",
      RELATED: "relates",
      related: "relates",
    }
    const comments = extractNodes(raw["comments"]).map(
      (c, i): TrackerComment => ({
        id: String(c["id"] ?? i),
        author: String((c["user"] as Record<string, unknown> | undefined)?.["name"] ?? c["userName"] ?? "unknown"),
        body: String(c["body"] ?? c["comment"] ?? ""),
        createdAt: String(c["createdAt"] ?? ""),
      }),
    )
    return {
      key: String(raw["identifier"] ?? raw["key"] ?? raw["id"] ?? ""),
      url: raw["url"] ? String(raw["url"]) : undefined,
      title: String(raw["title"] ?? ""),
      description: String(raw["description"] ?? raw["descriptionText"] ?? ""),
      comments,
      labels: labels.filter(Boolean),
      state: this.logicalFor(stateName),
      relations: relationsRaw.map((r) => {
        const issue = (r["issue"] ?? r["relatedIssue"]) as Record<string, unknown> | undefined
        return {
          kind: kindMap[String(r["type"] ?? "")] ?? "relates",
          key: String(issue?.["identifier"] ?? r["identifier"] ?? ""),
          state: this.logicalFor((issue as Record<string, unknown> | undefined)?.["state"]),
        }
      }),
      parentKey: (raw["parent"] as Record<string, unknown> | undefined)?.["identifier"]
        ? String((raw["parent"] as Record<string, unknown>)["identifier"])
        : undefined,
      projectName: (raw["project"] as Record<string, unknown> | undefined)?.["name"]
        ? String((raw["project"] as Record<string, unknown>)["name"])
        : undefined,
    }
  }

  private async fetchIssues(query: IssueQuery): Promise<Ticket[]> {
    await this.discoverWorkspace()
    const tool = await this.tool("list issues", ["list_issues", "search_issues", "issue_search", "list_issue"])
    const raw = await this.tb.callJson<Record<string, unknown>>(tool, {
      team: this.opts.team,
      teamId: this.opts.team,
      first: 50,
      limit: 50,
      includeRelations: true,
    })
    const items = extractNodes(raw).map((n) => this.normalizeIssue(n))
    const labelName = query.logicalLabel ? parseSelector(this.opts.map[query.logicalLabel] ?? "", "logicalLabel").name : undefined
    return items
      .filter((t) => (labelName ? t.labels.some((l) => l.toLowerCase() === labelName.toLowerCase()) : true))
      .filter((t) => (query.state ? t.state === query.state : true))
      .filter((t) => (query.project ? t.projectName === query.project : true))
  }

  async listIssues(query: IssueQuery): Promise<Ticket[]> {
    return this.fetchIssues(query)
  }

  async getTicket(key: string): Promise<Ticket> {
    const tool = await this.tool("get issue", ["get_issue", "search_issue_by_id", "issue"])
    const raw = await this.tb.callJson<Record<string, unknown>>(tool, { issueId: key, issueIdOrKey: key, id: key, identifier: key })
    const node = (raw["issue"] as Record<string, unknown> | undefined) ?? (raw as Record<string, unknown>)
    const ticket = this.normalizeIssue(node)
    if (!ticket.key) ticket.key = key
    return ticket
  }

  async comment(key: string, body: string, opts?: { editExistingTag?: string }): Promise<void> {
    if (opts?.editExistingTag) {
      const listTool = await this.tool("list comments", ["list_comments", "list_issue_comments", "issue_comments"]).catch(() => undefined)
      if (listTool) {
        const raw = await this.tb.callJson<unknown>(listTool, { issueId: key, issueIdOrKey: key, id: key })
        const existing = extractNodes(raw).find((c) => String(c["body"] ?? "").includes(opts.editExistingTag!))
        if (existing) {
          const updateTool = await this.tool("update comment", ["update_comment", "comment_update", "edit_comment"])
          await this.tb.callJson(updateTool, {
            commentId: existing["id"],
            id: existing["id"],
            body,
          })
          return
        }
      }
    }
    const tool = await this.tool("create comment", ["create_comment", "comment_create", "add_comment"])
    await this.tb.callJson(tool, { issueId: key, issueIdOrKey: key, id: key, body })
  }

  async addLabel(key: string, labelName: string): Promise<void> {
    const ws = this.ws ?? (await this.discoverWorkspace())
    const labelId = Object.entries(ws.labelIds).find(([name]) => name.toLowerCase() === labelName.toLowerCase())?.[1]
    const addTool = await this.tool("add label", ["add_label_to_issue", "issue_add_label", "add_label", "label_issue"]).catch(() => undefined)
    if (addTool && labelId) {
      await this.tb.callJson(addTool, { issueId: key, issueIdOrKey: key, id: key, labelId, label: labelId, name: labelName })
      return
    }
    // fall back to issue update with label ids/names
    const updateTool = await this.tool("update issue", ["update_issue", "issue_update", "edit_issue"])
    await this.tb.callJson(updateTool, {
      issueId: key,
      issueIdOrKey: key,
      id: key,
      labelIds: labelId ? [labelId] : undefined,
      labels: labelId ? undefined : [labelName],
    })
  }

  async moveTo(key: string, state: LogicalState): Promise<void> {
    const ws = this.ws ?? (await this.discoverWorkspace())
    const stateId = ws.stateIds[state]
    if (!stateId) throw new Error(`linear-mcp: no state mapped for logical "${state}"`)
    const tool = await this.tool("update issue", ["update_issue", "issue_update", "edit_issue"])
    await this.tb.callJson(tool, {
      issueId: key,
      issueIdOrKey: key,
      id: key,
      statusId: stateId,
      stateId: stateId,
      statusName: undefined,
    })
  }

  async setRelation(key: string, kind: "blocks" | "blocked-by" | "relates", otherKey: string): Promise<void> {
    const type = kind === "blocked-by" ? "BLOCKED_BY" : kind === "blocks" ? "BLOCKS" : "RELATED"
    const tool = await this.tool(
      "create relation",
      ["create_issue_relation", "issue_relation_add", "add_issue_relation", "relate_issues", "create_relation"],
    )
    await this.tb.callJson(tool, { issueId: key, id: key, relatedIssueId: otherKey, type })
  }

  async createSubIssue(parentKey: string, draft: TicketDraft): Promise<Ticket> {
    const tool = await this.tool("create issue", ["create_issue", "issue_create"])
    const raw = await this.tb.callJson<Record<string, unknown>>(tool, {
      team: this.opts.team,
      teamId: this.opts.team,
      title: draft.title,
      description: draft.description,
      parentId: parentKey,
      parentIssueId: parentKey,
    })
    const node = (raw["issue"] as Record<string, unknown> | undefined) ?? (raw as Record<string, unknown>)
    return this.normalizeIssue(node)
  }

  async createIssue(draft: TicketDraft): Promise<Ticket> {
    const tool = await this.tool("create issue", ["create_issue", "issue_create"])
    const raw = await this.tb.callJson<Record<string, unknown>>(tool, {
      team: this.opts.team,
      teamId: this.opts.team,
      title: draft.title,
      description: draft.description,
    })
    const node = (raw["issue"] as Record<string, unknown> | undefined) ?? (raw as Record<string, unknown>)
    return this.normalizeIssue(node)
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
    if ("identifier" in obj || "title" in obj) return [obj]
  }
  return []
}

function extractNamedIds(raw: unknown): { id: string; name: string }[] {
  return extractNodes(raw)
    .map((n) => ({ id: String(n["id"] ?? n["name"] ?? ""), name: String(n["name"] ?? n["label"] ?? "") }))
    .filter((x) => x.id && x.name)
}
