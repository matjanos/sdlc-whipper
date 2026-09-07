import { afterAll, describe, expect, it } from "vitest"
import type { Server } from "node:http"
import { createCockpitServer } from "../src/conductor/server.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const servers: Server[] = []

afterAll(() => {
  for (const s of servers) s.close()
})

async function start(deps: ReturnType<typeof wireFakes>["deps"]): Promise<number> {
  const server = await createCockpitServer(deps, { port: 0 })
  servers.push(server)
  const address = server.address()
  if (!address || typeof address !== "object") throw new Error("server did not expose a port")
  return address.port
}

describe("cockpit server", () => {
  it("GET /api/state returns a full snapshot: tickets, counts, budget, live", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [
      ticket({ key: "TST-1", labels: ["selected"] }),
      ticket({
        key: "TST-2",
        labels: ["selected"],
        relations: [{ kind: "blocked-by", key: "TST-1", state: "backlog" }],
      }),
    ])
    const port = await start(deps)
    const res = await fetch(`http://127.0.0.1:${port}/api/state`)
    expect(res.status).toBe(200)
    const snap = (await res.json()) as {
      counts: Record<string, number>
      tickets: { key: string; ready: boolean; blockedBy: string[] }[]
      budget: { total: { tokens: number } }
      live: { serviceUp: boolean; sessions: unknown[] }
    }
    expect(snap.counts["readyNow"]).toBe(1)
    expect(snap.counts["blocked"]).toBe(1)
    const t2 = snap.tickets.find((t) => t.key === "TST-2")
    expect(t2?.blockedBy).toEqual(["TST-1"])
    expect(snap.live.serviceUp).toBe(false) // no opencode service in tests
    expect(Array.isArray(snap.live.sessions)).toBe(true)
  })

  it("GET / serves the cockpit page", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [])
    const port = await start(deps)
    const res = await fetch(`http://127.0.0.1:${port}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    expect(html).toContain("cockpit")
    expect(html).toContain("api/events")
  })

  it("SSE stream sends an initial state event", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [ticket({ key: "TST-1" })])
    const port = await start(deps)
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let chunk = ""
    while (!chunk.includes("event: state")) {
      const { value } = await reader.read()
      if (!value) break
      chunk += decoder.decode(value)
    }
    expect(chunk).toContain("event: state")
    controller.abort()
    reader.cancel().catch(() => undefined)
  })

  it("POST /api/action: unknown actions are 501 with the planned list", async () => {
    const { config } = await makeTempRepo()
    const { deps } = wireFakes(config, [])
    const port = await start(deps)
    const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "open-preview" }),
    })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { planned: string[] }
    expect(body.planned).toContain("open-preview")
  })

  it("POST /api/action approve routes to the code host", async () => {
    const { config } = await makeTempRepo()
    const { deps, codehost } = wireFakes(config, [])
    codehost.openPR({ title: "t", body: "b", head: "h", base: "main" })
    const port = await start(deps)
    const res = await fetch(`http://127.0.0.1:${port}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "approve", pr: 1 }),
    })
    expect(res.status).toBe(200)
    expect(codehost.calls).toContainEqual({ op: "review", args: [1, "approve", expect.any(String)] })
  })
})
