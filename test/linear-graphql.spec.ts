import { describe, expect, it } from "vitest"
import { LinearTracker } from "../src/adapters/tracker-linear/index.js"

/**
 * The GraphQL Linear adapter against a stubbed transport. Pins the two things
 * that keep whipper inside Linear's request quota and readable when throttled:
 * server-side filters (labels/state/project never ship the whole team's
 * issues), and bounded rate-limit retries that honor the server's declared
 * wait instead of hammering through a RATELIMITED window.
 */

const MAP = {
  selected: "label:sdlc-selected",
  needsInfo: "label:needs-info",
  inProgress: "state:In Progress",
  inReview: "state:In Review",
  done: "state:Done",
  cancelled: "state:Canceled",
}

const TEAM = {
  data: {
    team: {
      id: "team-1",
      key: "LIN",
      states: {
        nodes: [
          { id: "s1", name: "Backlog" },
          { id: "s2", name: "In Progress" },
          { id: "s3", name: "In Review" },
          { id: "s4", name: "Done" },
          { id: "s5", name: "Canceled" },
        ],
      },
      labels: {
        nodes: [
          { id: "l1", name: "sdlc-selected" },
          { id: "l2", name: "needs-info" },
        ],
      },
    },
  },
}

function issueNode(key: string, over: Record<string, unknown> = {}) {
  return {
    id: `id-${key}`,
    identifier: key,
    title: `title ${key}`,
    url: `https://linear.app/lin/${key}`,
    description: "",
    state: { name: "Backlog" },
    labels: { nodes: [] },
    relations: { nodes: [] },
    parent: null,
    project: null,
    ...over,
  }
}

function issuesPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { issues: { nodes, pageInfo: { hasNextPage, endCursor } } } }
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function rateLimited(headers: Record<string, string> = {}) {
  return json({ errors: [{ message: "Rate limited", extensions: { code: "RATELIMITED" } }] }, 400, headers)
}

function makeAdapter(responses: Response[]) {
  const requests: { url: string; body: string }[] = []
  const delays: number[] = []
  const warns: string[] = []
  const fetchImpl = async (_url: string, init: RequestInit) => {
    requests.push({ url: _url, body: String(init.body) })
    const next = responses.shift()
    if (!next) throw new Error("stub exhausted — unexpected extra request")
    return next
  }
  const tracker = new LinearTracker({
    team: "LIN",
    map: MAP,
    apiKey: "test-key",
    fetch: fetchImpl,
    delay: async (ms) => {
      delays.push(ms)
    },
    warn: (m) => warns.push(m),
  })
  return { tracker, requests, delays, warns }
}

async function body(requestIndex: number, requests: { body: string }[]): Promise<Record<string, unknown>> {
  return JSON.parse(requests[requestIndex]!.body) as Record<string, unknown>
}

describe("LinearTracker (GraphQL)", () => {
  it("discovers the workspace and maps states/labels", async () => {
    const { tracker, requests } = makeAdapter([json(TEAM)])
    const ws = await tracker.discoverWorkspace()
    expect(ws.teamKey).toBe("LIN")
    expect(ws.stateIds["done"]).toBe("s4")
    expect(ws.labelIds["sdlc-selected"]).toBe("l1")
    expect(requests).toHaveLength(1)
  })

  it("listIssues pushes label/state/project filters server-side", async () => {
    const { tracker, requests } = makeAdapter([
      json(TEAM),
      json(
        issuesPage([
          issueNode("LIN-1", {
            state: { name: "In Progress" },
            labels: { nodes: [{ name: "sdlc-selected" }] },
            project: { name: "Proj" },
          }),
          // off-scope noise the stub "server" ignored the filters for
          issueNode("LIN-2", { state: { name: "Done" }, project: { name: "Other" } }),
        ]),
      ),
    ])
    const tickets = await tracker.listIssues({ logicalLabel: "selected", state: "inProgress", project: "Proj" })

    const sent = await body(1, requests)
    const query = String(sent.query)
    expect(query).toContain("labels: { name: { in: $labelNames } }")
    expect(query).toContain("state: { name: { eq: $stateName } }")
    expect(query).toContain("project: { name: { eq: $projectName } }")
    expect(sent.variables).toEqual({
      teamId: "team-1",
      after: null,
      labelNames: ["sdlc-selected"],
      stateName: "In Progress",
      projectName: "Proj",
    })

    // the local pass guarantees the contract even when the server ignores filters
    expect(tickets.map((t) => t.key)).toEqual(["LIN-1"])
    expect(tickets[0]!.state).toBe("inProgress")
  })

  it("omits unused filter variables instead of sending dead declarations", async () => {
    const { tracker, requests } = makeAdapter([json(TEAM), json(issuesPage([issueNode("LIN-3")]))])
    await tracker.listIssues({})
    const sent = await body(1, requests)
    expect(sent.variables).toEqual({ teamId: "team-1", after: null })
    expect(String(sent.query)).toContain("filter: { team: { id: { eq: $teamId } } }")
    expect(String(sent.query)).not.toContain("$labelNames")
  })

  it("paginates with the server cursor", async () => {
    const { tracker, requests } = makeAdapter([
      json(TEAM),
      json(issuesPage([issueNode("LIN-1")], true, "cursor-1")),
      json(issuesPage([issueNode("LIN-2")])),
    ])
    const tickets = await tracker.listIssues({})
    expect(tickets.map((t) => t.key)).toEqual(["LIN-1", "LIN-2"])
    const second = await body(2, requests)
    expect((second.variables as Record<string, unknown>)["after"]).toBe("cursor-1")
  })

  it("retries a RATELIMITED call once per the declared wait and succeeds", async () => {
    const { tracker, requests, delays, warns } = makeAdapter([
      json(TEAM),
      rateLimited({ "retry-after": "7" }),
      json(issuesPage([issueNode("LIN-1")])),
    ])
    const tickets = await tracker.listIssues({})
    expect(tickets.map((t) => t.key)).toEqual(["LIN-1"])
    expect(requests).toHaveLength(3)
    expect(delays).toEqual([7000])
    expect(warns.join(" ")).toContain("rate limited")
  })

  it("honors epoch-ms reset headers over blind backoff", async () => {
    const soon = Date.now() + 4_000
    const { tracker, delays } = makeAdapter([
      json(TEAM),
      rateLimited({ "x-ratelimit-requests-reset": String(soon) }),
      json(issuesPage([])),
    ])
    await tracker.listIssues({})
    expect(delays[0]).toBeGreaterThan(0)
    expect(delays[0]).toBeLessThanOrEqual(4_000)
  })

  it("gives up after bounded attempts and names the quota state", async () => {
    const { tracker, requests, delays } = makeAdapter([json(TEAM), rateLimited(), rateLimited(), rateLimited()])
    await expect(tracker.listIssues({})).rejects.toThrow(/RATELIMITED/)
    expect(requests).toHaveLength(4) // discovery + 3 bounded attempts
    expect(delays).toEqual([2000, 4000]) // exponential fallback, capped, no header declared
  })

  it("tolerates a non-JSON error body and reports the HTTP status", async () => {
    const { tracker } = makeAdapter([json(TEAM), new Response("<html>bad gateway</html>", { status: 502 })])
    await expect(tracker.listIssues({})).rejects.toThrow("Linear API error: HTTP 502")
  })
})
