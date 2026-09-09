import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { ConductorDeps } from "./deps.js"
import { buildSnapshot } from "./snapshot.js"
import { TrackerMirror } from "./tracker-mirror.js"

/**
 * `sdlc serve` — the cockpit server. Read-heavy by design: GET endpoints
 * stream the process state; the only mutations map 1:1 to things the CLI can
 * also do (interrupt sessions, approve a PR). The CLI stays the first-class
 * citizen; this is the secondary control surface.
 *
 * Security posture: binds 127.0.0.1 unless SDL_SERVE_HOST overrides; if
 * SDL_SERVE_TOKEN is set, every request must carry it (query or bearer).
 */
const COCKPIT_HTML = fileURLToPath(new URL("../../docs/cockpit.html", import.meta.url))

export interface ServeOptions {
  port: number
  host?: string
}

export async function createCockpitServer(deps: ConductorDeps, opts: ServeOptions): Promise<Server> {
  const token = process.env["SDL_SERVE_TOKEN"]
  const host = opts.host ?? process.env["SDL_SERVE_HOST"] ?? "127.0.0.1"

  // One local read-model shared by every endpoint. Reads never hit the
  // tracker; a background loop keeps the mirror warm under the refresh
  // policy (bounded cadence, backoff when the tracker throttles).
  const mirror = new TrackerMirror(
    deps.tracker,
    path.join(deps.config.whipperDir, "tracker-cache.json"),
    deps.log,
    {},
    { project: deps.config.raw.tracker.project },
  )
  const warmer = setInterval(() => void mirror.refreshIfDue(), 5_000)
  warmer.unref?.()
  // start the first sweep now, so first paint reads local state immediately
  // and the tracker sync lands underneath it
  void mirror.refreshIfDue()

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      deps.log.error(`serve: ${(err as Error).message}`)
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(opts.port, host, () => resolve())
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost")
    if (token && !authorized(url, req, token)) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "unauthorized" }))
      return
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
      res.end(readFileSync(COCKPIT_HTML))
      return
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const snapshot = await buildSnapshot(deps, mirror)
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify(snapshot))
      return
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      })
      res.write("retry: 3000\n\n")
      let lastHash = ""
      const emit = async (): Promise<void> => {
        if (res.writableEnded || res.destroyed) return
        try {
          const snapshot = await buildSnapshot(deps, mirror)
          if (res.writableEnded || res.destroyed) return
          const json = JSON.stringify(snapshot)
          // hash on content that matters — ts changes every poll
          const hash = JSON.stringify({
            c: snapshot.counts,
            l: snapshot.live,
            r: snapshot.runs,
            b: snapshot.budget,
            e: snapshot.events.at(-1)?.ts,
          })
          if (hash !== lastHash) {
            lastHash = hash
            res.write(`event: state\ndata: ${json}\n\n`)
          } else {
            res.write(": keepalive\n\n")
          }
        } catch (err) {
          if (res.writableEnded || res.destroyed) return
          res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`)
        }
      }
      void emit()
      const timer = setInterval(() => void emit(), 2500)
      req.on("close", () => clearInterval(timer))
      return
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const body = await readBody(req)
      const action = body as { type?: string; sessionId?: string; pr?: number; body?: string }
      switch (action.type) {
        case "interrupt": {
          const killed = await interruptSessions(deps, mirror, action.sessionId)
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true, interrupted: killed }))
          return
        }
        case "approve": {
          if (!action.pr) throw new Error("approve: pr number required")
          await deps.codehost.review(action.pr, "approve", action.body ?? "sdlc cockpit approval")
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        default:
          res.writeHead(501, { "content-type": "application/json" })
          res.end(
            JSON.stringify({
              error: `action "${action.type ?? "?"}" not implemented yet`,
              planned: ["park", "retry-phase", "open-preview", "comment"],
            }),
          )
          return
      }
    }

    res.writeHead(404, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: `no route: ${req.method} ${url.pathname}` }))
  }

  const address = server.address()
  const actualPort = address && typeof address === "object" ? address.port : opts.port
  deps.log.info(`cockpit: http://${host}:${actualPort} (state: /api/state · events: /api/events)`)
  return server
}

function authorized(url: URL, req: IncomingMessage, token: string): boolean {
  if (url.searchParams.get("token") === token) return true
  const header = req.headers["authorization"]
  return header === `Bearer ${token}`
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString("utf8")
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error("invalid JSON body")
  }
}

/** Kill one sdlc session (sessionId) or every running one for this project. */
async function interruptSessions(deps: ConductorDeps, mirror: TrackerMirror, sessionId?: string): Promise<number> {
  const snapshot = await buildSnapshot(deps, mirror)
  const targets = snapshot.live.sessions.filter((s) => (sessionId ? s.id === sessionId : s.running))
  if (!snapshot.live.serviceUp) throw new Error("opencode service not reachable")
  const [{ OpenCode }, { Service }] = (await Promise.all([
    import("@opencode-ai/client"),
    import("@opencode-ai/client/service"),
  ])) as unknown as [
    { OpenCode: { make(o: { baseUrl: string; headers?: Record<string, string> }): import("./snapshot.js").OpencodeClient } },
    { Service: { discover(): Promise<{ url: string } | undefined>; headers(e: { url: string }): Record<string, string> | undefined } },
  ]
  const endpoint = await Service.discover()
  if (!endpoint) throw new Error("opencode service not reachable")
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  let killed = 0
  for (const t of targets) {
    try {
      await client["session.interrupt"]({ sessionID: t.id, continue: false })
      killed += 1
    } catch {
      /* already finished */
    }
  }
  return killed
}
