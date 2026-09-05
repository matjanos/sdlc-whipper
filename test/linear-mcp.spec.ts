import { describe, expect, it } from "vitest"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"
import { LinearMcpTracker } from "../src/adapters/tracker-linear-mcp/index.js"
import { McpToolbox } from "../src/adapters/mcp/client.js"

/**
 * linear-mcp adapter against an in-memory MCP server that mimics the official
 * Linear MCP tool surface. Verifies the adapter's defensive mapping: tool
 * resolution by candidates, argument aliases, tolerant payload extraction.
 */
async function makeServer(options: { omitStatuses?: boolean } = {}) {
  const server = new McpServer({ name: "linear-stub", version: "0.0.0" })
  const state: { issues: any[]; comments: Record<string, any[]> } = { issues: [], comments: {} }

  server.tool("list_issue_statuses", { team: z.string().optional() }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          issueStatuses: {
            nodes: [
              { id: "st_backlog", name: "Backlog" },
              { id: "st_progress", name: "In Progress" },
              { id: "st_done", name: "Done" },
            ],
          },
        }),
      },
    ],
  }))
  server.tool("list_labels", { team: z.string().optional() }, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({ nodes: [{ id: "lbl_sel", name: "sdlc-selected" }, { id: "lbl_info", name: "needs-info" }] }),
      },
    ],
  }))
  server.tool("create_issue", { team: z.string(), title: z.string(), description: z.string(), parentId: z.string().optional() }, async (args) => {
    const issue = {
      id: `i${state.issues.length + 1}`,
      identifier: `TST-${state.issues.length + 1}`,
      title: args.title,
      description: args.description,
      state: { name: "Backlog" },
      labels: { nodes: [] },
      relations: { nodes: [] },
      parent: args.parentId ? { identifier: args.parentId } : null,
    }
    state.issues.push(issue)
    return { content: [{ type: "text", text: JSON.stringify({ issue }) }] }
  })
  server.tool("get_issue", { issueId: z.string() }, async (args) => {
    const issue = state.issues.find((i) => i.identifier === args.issueId)
    if (!issue) return { content: [{ type: "text", text: "not found" }], isError: true }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ issue: { ...issue, comments: { nodes: state.comments[args.issueId] ?? [] } } }),
        },
      ],
    }
  })
  server.tool("list_issues", { team: z.string().optional() }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ issues: state.issues }) }],
  }))
  server.tool("create_comment", { issueId: z.string(), body: z.string() }, async (args) => {
    ;(state.comments[args.issueId] ??= []).push({ id: `c${Date.now()}`, body: args.body, user: { name: "conductor" }, createdAt: "now" })
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
  })
  server.tool("update_comment", { commentId: z.string(), body: z.string() }, async (args) => {
    for (const list of Object.values(state.comments)) {
      const c = list.find((c) => c.id === args.commentId)
      if (c) c.body = args.body
    }
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
  })
  server.tool("list_comments", { issueId: z.string() }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify({ comments: state.comments[args.issueId] ?? [] }) }],
  }))
  server.tool("add_label", { issueId: z.string(), name: z.string().optional(), labelId: z.string().optional() }, async (args) => {
    const issue = state.issues.find((i) => i.identifier === args.issueId)
    const name = args.name ?? (args.labelId === "lbl_sel" ? "sdlc-selected" : args.labelId === "lbl_info" ? "needs-info" : args.labelId)
    if (issue && name) issue.labels.nodes.push({ name })
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
  })
  server.tool("update_issue", { issueId: z.string(), statusId: z.string().optional(), labelIds: z.array(z.string()).optional(), labels: z.array(z.string()).optional() }, async (args) => {
    const issue = state.issues.find((i) => i.identifier === args.issueId)
    if (issue && args.statusId) issue.state = { name: args.statusId === "st_progress" ? "In Progress" : args.statusId === "st_done" ? "Done" : "Backlog" }
    if (issue && args.labels) issue.labels.nodes.push(...args.labels.map((name) => ({ name })))
    return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] }
  })
  server.tool("create_issue_relation", { issueId: z.string(), relatedIssueId: z.string(), type: z.string() }, async () => ({
    content: [{ type: "text", text: JSON.stringify({ success: true }) }],
  }))

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
    expect(state.issues[0]!.state.name).toBe("In Progress")
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

  it("fails loudly when a mapped state is missing from the workspace", async () => {
    const { clientTransport } = await makeServer()
    const tracker = new LinearMcpTracker({ team: "TST", map: { ...MAP, inProgress: "state:Does Not Exist" }, transport: clientTransport })
    await expect(tracker.discoverWorkspace()).rejects.toThrow(/Does Not Exist/)
  })
})
