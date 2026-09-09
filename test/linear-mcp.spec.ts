import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { LinearMcpTracker } from "../src/adapters/tracker-linear-mcp/index.js"
import { McpToolbox } from "../src/adapters/mcp/client.js"

/**
 * linear-mcp adapter against an in-memory MCP server that mimics the official
 * Linear MCP tool surface (save_issue/get_issue naming, strict argument
 * validation, flat issue payloads with grouped relations that carry no
 * state). Verifies the adapter's defensive mapping: tool resolution by
 * candidates, per-tool argument shapes, tolerant payload extraction, and
 * relation-state hydration.
 */
async function makeServer(options: { omitStatuses?: boolean } = {}) {
  const server = new McpServer({ name: "linear-stub", version: "0.0.0" })
  const state: { issues: any[]; comments: Record<string, any[]> } = { issues: [], comments: {} }

  const find = (id: string) => state.issues.find((i) => i.id === id)

  server.tool("list_issue_statuses", { team: z.string() }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify([
          { id: "st_backlog", name: "Backlog", type: "backlog" },
          { id: "st_progress", name: "In Progress", type: "started" },
          { id: "st_done", name: "Done", type: "completed" },
        ]),
      },
    ],
  }))
  server.tool("list_issue_labels", { team: z.string() }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          labels: [
            { id: "lbl_sel", name: "sdlc-selected" },
            { id: "lbl_info", name: "needs-info" },
          ],
        }),
      },
    ],
  }))
  server.tool(
    "save_issue",
    {
      id: z.string().optional(),
      team: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      parentId: z.string().optional(),
      state: z.string().optional(),
      addLabels: z.array(z.string()).optional(),
      blockedBy: z.array(z.string()).optional(),
      blocks: z.array(z.string()).optional(),
    },
    async (args) => {
      if (args.id) {
        const issue = find(args.id)
        if (!issue) return { content: [{ type: "text", text: "not found" }], isError: true }
        if (args.state) issue.status = args.state
        if (args.addLabels) issue.labels.push(...args.addLabels)
        if (args.blockedBy) issue.relations.blockedBy.push(...args.blockedBy.map((id: string) => ({ id, title: find(id)?.title ?? "" })))
        if (args.blocks) for (const id of args.blocks) {
          const other = find(id)
          other.relations.blockedBy.push({ id: args.id, title: issue.title })
          issue.relations.blocks.push({ id, title: other.title })
        }
        return { content: [{ type: "text", text: JSON.stringify(issue) }] }
      }
      const issue = {
        id: `TST-${state.issues.length + 1}`,
        title: args.title,
        description: args.description,
        status: "Backlog",
        labels: [] as string[],
        relations: { blocks: [], blockedBy: [], relatedTo: [] },
        parent: args.parentId ? { identifier: args.parentId } : undefined,
        parentId: args.parentId,
        project: null,
        url: `https://linear.app/test/issue/${`TST-${state.issues.length + 1}`}`,
      }
      state.issues.push(issue)
      return { content: [{ type: "text", text: JSON.stringify(issue) }] }
    },
  )
  server.tool("get_issue", { id: z.string(), includeRelations: z.boolean().optional() }, async (args) => {
    const issue = find(args.id)
    if (!issue) return { content: [{ type: "text", text: "not found" }], isError: true }
    const payload: any = { ...issue, comments: undefined }
    if (args.includeRelations) payload.relations = issue.relations
    return { content: [{ type: "text", text: JSON.stringify(payload) }] }
  })
  server.tool("list_issues", { team: z.string().optional(), project: z.string().optional(), limit: z.number().optional() }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ issues: state.issues, hasNextPage: false }) }],
  }))
  server.tool("list_comments", { issueId: z.string(), limit: z.number().optional() }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify({ comments: state.comments[args.issueId] ?? [] }) }],
  }))
  server.tool("save_comment", { id: z.string().optional(), issueId: z.string().optional(), body: z.string() }, async (args) => {
    if (args.id) {
      for (const list of Object.values(state.comments)) {
        const c = list.find((c) => c.id === args.id)
        if (c) c.body = args.body
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
    }
    ;(state.comments[args.issueId!] ??= []).push({ id: `c${Date.now()}`, body: args.body, user: { name: "conductor" }, createdAt: "now" })
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
  })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  return { clientTransport, state }
}

const MAP = {
  selected: "label:sdlc-selected",
  needsInfo: "label:needs-info",
  inProgress: "state:In Progress",
  done: "state:Done",
}

describe("linear-mcp adapter", () => {
  it("resolves tools by candidates and passes contract flows", async () => {
    const { clientTransport, state } = await makeServer()
    const tracker = new LinearMcpTracker({ team: "TST", map: MAP, transport: clientTransport })

    const ws = await tracker.discoverWorkspace()
    expect(ws.stateIds["inProgress"]).toBe("st_progress")
    expect(ws.labelIds["sdlc-selected"]).toBe("lbl_sel")

    const created = await tracker.createIssue({ title: "Hello", description: "World" })
    expect(created.key).toBe("TST-1")
    expect(created.state).toBe("backlog")

    await tracker.moveTo(created.key, "inProgress")
    expect(state.issues[0]!.status).toBe("In Progress")
    expect((await tracker.getTicket(created.key)).state).toBe("inProgress")

    await tracker.comment(created.key, "hello <!-- t1 -->")
    await tracker.comment(created.key, "hello edited <!-- t1 -->", { editExistingTag: "<!-- t1 -->" })
    const t = await tracker.getTicket(created.key)
    expect(t.comments).toHaveLength(1)
    expect(t.comments[0]!.body).toContain("edited")

    await tracker.addLabel(created.key, "sdlc-selected")
    expect((await tracker.getTicket(created.key)).labels).toContain("sdlc-selected")

    const listed = await tracker.listIssues({ logicalLabel: "selected" })
    expect(listed.map((x) => x.key)).toContain("TST-1")
  })

  it("hydrates relation states so done blockers stop gating", async () => {
    const { clientTransport } = await makeServer()
    const tracker = new LinearMcpTracker({ team: "TST", map: MAP, transport: clientTransport })

    const a = await tracker.createIssue({ title: "Blocker", description: "first" })
    const b = await tracker.createIssue({ title: "Blocked", description: "second" })
    await tracker.setRelation(b.key, "blocked-by", a.key)

    // while the blocker is open, the relation state reflects a non-done state
    let ticket = await tracker.getTicket(b.key)
    expect(ticket.relations).toContainEqual(expect.objectContaining({ kind: "blocked-by", key: a.key, state: "backlog" }))

    await tracker.moveTo(a.key, "done")
    ticket = await tracker.getTicket(b.key)
    expect(ticket.relations).toContainEqual(expect.objectContaining({ kind: "blocked-by", key: a.key, state: "done" }))
  })

  it("sub-issues carry parent and project scope", async () => {
    const { clientTransport, state } = await makeServer()
    const tracker = new LinearMcpTracker({ team: "TST", project: "SDLC Whipper", map: MAP, transport: clientTransport })

    const parent = await tracker.createIssue({ title: "Parent", description: "p" })
    const child = await tracker.createSubIssue(parent.key, { title: "Child", description: "c" })
    expect(child.parentKey).toBe(parent.key)
    expect(state.issues[1]!.parentId).toBe(parent.key)
  })

  it("fails loudly when a mapped state is missing from the workspace", async () => {
    const { clientTransport } = await makeServer()
    const tracker = new LinearMcpTracker({ team: "TST", map: { ...MAP, inProgress: "state:Does Not Exist" }, transport: clientTransport })
    await expect(tracker.discoverWorkspace()).rejects.toThrow(/Does Not Exist/)
  })
})
