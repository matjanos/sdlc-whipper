import type { AgentActivity, AgentRuntime, LedgerStore, PromptOptions, RunContext } from "../../ports/index.js"
import type { AgentRole, PromptParts } from "../../types.js"
import { ModelCallFailedError } from "../../types.js"
import { resolveModel } from "../../config.js"
import { writeWorktreeAgentConfig, agentId } from "./agents.js"
import { fetchCatalog, invalidModelRefs, parseModelRef, type CatalogEntry, type ModelRef } from "./models.js"
import { usageEntryFromEvent } from "./usage.js"
import { ActivityTracker } from "./activity.js"
import { isTransient } from "../../conductor/retry.js"
import { sleep } from "../../util/exec.js"

/** Domain-level error; conductor maps provider rate limits to parked escalations. */
export { ModelCallFailedError }

/**
 * Structural types for the OpenCode V2 client. Kept local on purpose: generated
 * API types churn; if a field moves, only this adapter changes. (M2 spike:
 * verify event/message shapes against the running server's /openapi.json.)
 */
interface SdkSessionInfo {
  id: string
}
interface SdkSessions {
  create(input: { location: { directory: string }; title?: string }): Promise<SdkSessionInfo>
  switchAgent(input: { sessionID: string; agent: string }): Promise<void>
  switchModel(input: { sessionID: string; model: { providerID: string; id: string; variant?: string } }): Promise<void>
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  wait(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<unknown>
  active(): Promise<unknown>
  interrupt(input: { sessionID: string; continue: boolean }): Promise<void>
}
interface SdkEvents {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>
}
interface SdkHost {
  sessions: SdkSessions
  events: SdkEvents
  close(): Promise<void>
}

export interface OpenCodeRuntimeOptions {
  /** Resolved target-repo config — used to inject agent definitions into worktrees. */
  config: Parameters<typeof writeWorktreeAgentConfig>[0]
  /** Directory sessions run in when the run has no worktree (grooming). */
  fallbackDirectory?: string
  ledger?: LedgerStore
  /** Live agent-activity observer (spinner/UI). Registered once, fired on meaningful changes. */
  onActivity?: (info: AgentActivity) => void
  /** Poll interval while waiting for an assistant message. */
  assistantPollMs?: number
  /** Absolute cap on waiting for one agent run (tool loops can be long). */
  assistantMaxMs?: number
}

/**
 * AgentRuntime over the OpenCode V2 background-service client. The embedded
 * SDK's current dev package cannot be imported under Node ESM (its server
 * dependency uses an unsupported directory import), so the documented client
 * fallback is the production path for now. Sessions remain keyed by role per
 * run: executor follow-ups reuse context, while reviewer rounds start fresh.
 *
 * Agent definitions are injected into the run's worktree as
 * `.opencode/opencode.json` (never committed) — target repos need no
 * `.opencode/agents/` entries. The user's global opencode config still
 * applies (providers, MCP servers like Linear).
 */
export class OpenCodeRuntime implements AgentRuntime {
  private host?: SdkHost
  private run?: RunContext
  private readonly sessions = new Map<AgentRole, string>() // role → sessionID
  private readonly roleBySession = new Map<string, AgentRole>() // for usage attribution
  private readonly activityObservers: ((info: AgentActivity) => void)[] = []
  private serviceUrl?: string
  private serviceHeaders?: Record<string, string>
  private closed = false

  constructor(private readonly opts: OpenCodeRuntimeOptions) {}

  private directory(): string {
    return this.run?.worktree ?? this.opts.fallbackDirectory ?? process.cwd()
  }

  private async ensureHost(): Promise<SdkHost> {
    if (this.host) return this.host
    const [{ OpenCode }, { Service }] = (await Promise.all([
      import("@opencode/client"),
      import("@opencode/client/service"),
    ])) as unknown as [
      { OpenCode: { make(options: { baseUrl: string; headers?: Record<string, string> }): { session: SdkSessions; event: SdkEvents } } },
      { Service: { ensure(): Promise<{ url: string }>; headers(endpoint: { url: string }): Record<string, string> | undefined } },
    ]
    const endpoint = await Service.ensure()
    const headers = Service.headers(endpoint)
    this.serviceUrl = endpoint.url
    this.serviceHeaders = headers
    // v2 services multiplex event delivery per client: a slow subscriber makes
    // the shared source wait, which stalls session calls on the same client.
    // Sessions and events therefore ride separate clients, and consumeEvents
    // accepts events fast, processing them off the subscription loop.
    const sessionClient = OpenCode.make({ baseUrl: endpoint.url, headers })
    const eventClient = OpenCode.make({ baseUrl: endpoint.url, headers })
    this.host = {
      sessions: sessionClient.session,
      events: eventClient.event,
      // The conductor does not own the shared background service, so it must
      // never stop it when one delivery finishes.
      close: async () => undefined,
    }
    void this.consumeEvents().catch(() => undefined)
    return this.host
  }

  async open(run: RunContext): Promise<void> {
    this.run = run
    this.sessions.clear()
    this.roleBySession.clear()
    this.closed = false
    // Agent definitions must exist wherever the session runs — worktree or
    // not. opencode v2 resolves the agent's own model ahead of the session
    // model, so a missing definition silently routes to the service default
    // (a tool-use-less endpoint). Batch phases (grooming) have no worktree;
    // they still get the conductor's pinned agents in their run directory.
    writeWorktreeAgentConfig(this.opts.config, this.directory())
    await this.ensureHost()
    await this.preflightModels()
  }

  /**
   * Fail fast on unknown model refs: switchModel accepts bogus ids silently
   * and the session then hangs until polling dies — a typo must cost one
   * second, not a delivery. Validates the configured refs against the live
   * catalog (`GET /api/model`); if the catalog is unreachable (older server,
   * transient blip) validation is skipped rather than blocking deliveries.
   */
  private async preflightModels(): Promise<void> {
    const roles = Object.keys(this.opts.config.raw.agents ?? {}) as AgentRole[]
    const refs = roles
      .map((role) => ({ role, parsed: this.modelRef(role) }))
      .filter((r): r is { role: AgentRole; parsed: NonNullable<(typeof r)["parsed"]> } => r.parsed !== undefined)
    if (refs.length === 0) return
    let catalog: CatalogEntry[]
    try {
      catalog = await liveModelCatalog()
    } catch {
      return // cannot validate without the catalog — never block a delivery on it
    }
    const problems = invalidModelRefs(refs, catalog)
    if (problems.length > 0) {
      throw new Error(
        `opencode runtime: unknown model configuration(s) — check models/agents in .whipper/config.json (see \`opencode models\`):\n` +
          problems.map((p) => `  ${p.role}: ${p.ref} — ${p.detail}`).join("\n"),
      )
    }
  }

  private async sessionFor(role: AgentRole, fresh: boolean): Promise<string> {
    const host = await this.ensureHost()
    const existing = this.sessions.get(role)
    if (existing && !fresh) return existing
    const session = await host.sessions.create({
      location: { directory: this.directory() },
      title: `sdlc:${this.run?.ticket ?? "?"}:${role}`,
    })
    this.sessions.set(role, session.id)
    this.roleBySession.set(session.id, role)
    return session.id
  }

  /** Parse `provider/id[#variant]` from config. */
  private modelRef(role: AgentRole): ModelRef | undefined {
    const ref = resolveModel(this.opts.config, role)
    if (!ref) return undefined
    return parseModelRef(ref)
  }

  async prompt(role: AgentRole, parts: PromptParts, opts?: PromptOptions): Promise<string> {
    const host = await this.ensureHost()
    const sessionID = await this.sessionFor(role, opts?.fresh === true)
    await host.sessions.switchAgent({ sessionID, agent: agentId(role) })
    // Agent-config model fields are not reliably applied to new sessions —
    // set the model explicitly so conductor config is the single source of truth.
    const model = this.modelRef(role)
    if (model) {
      try {
        await host.sessions.switchModel({ sessionID, model })
      } catch (err) {
        throw new Error(
          `opencode runtime: cannot set model ${model.providerID}/${model.id} for ${role} — check providers/auth (${(err as Error).message})`,
        )
      }
    }
    const text = parts.attachFiles?.length
      ? `${parts.text}\n\nAttached context files: ${parts.attachFiles.join(", ")}`
      : parts.text
    try {
      await host.sessions.prompt({ sessionID, text })
      await host.sessions.wait({ sessionID })
    } catch (err) {
      // Long-poll transports can drop while the server is still retrying the
      // provider. Before failing the phase, check whether the run actually
      // completed. Bounded, in code.
      if (!isTransient(err)) throw err
    }
    // `wait` can resolve before the run actually starts (idle race on fresh
    // sessions), so poll for the assistant message instead of reading once.
    return await this.awaitAssistant(sessionID)
  }

  /**
   * Poll session context until an assistant text appears. Agent runs loop on
   * tools for a long time before answering, so while the server reports the
   * session as actively running we keep waiting (up to `assistantMaxMs`,
   * default 30 min). A session that goes idle without producing a message
   * gets a short grace window, then we fail — that is a stuck run, not a
   * working one. Error-carrying assistant messages are terminal.
   */
  private async awaitAssistant(sessionID: string): Promise<string> {
    const intervalMs = this.opts.assistantPollMs ?? 15_000
    const maxIdlePolls = 6 // ~90s of idle-with-no-message before giving up
    const deadline = Date.now() + (this.opts.assistantMaxMs ?? 30 * 60_000)
    let idlePolls = 0
    for (let i = 0; Date.now() < deadline; i++) {
      if (i > 0) {
        await sleep(intervalMs)
        if (this.closed || !this.host) break
      }
      const host = this.host
      if (!host) break
      try {
        return lastAssistantText(await host.sessions.context({ sessionID }))
      } catch (err) {
        if (err instanceof ModelCallFailedError) throw err
        /* no assistant text yet — check liveness below */
      }
      const running = await this.isRunning(host, sessionID)
      idlePolls = running ? 0 : idlePolls + 1
      if (idlePolls >= maxIdlePolls) {
        throw new Error(
          `opencode runtime: session idle for ${maxIdlePolls} polls with no assistant message (${sessionID})`,
        )
      }
    }
    throw new Error(
      `opencode runtime: session produced no assistant message within the polling window (${sessionID})`,
    )
  }

  private async isRunning(host: SdkHost, sessionID: string): Promise<boolean> {
    try {
      const raw = await host.sessions.active()
      const map = ((raw as Record<string, any>)?.data ?? raw) as Record<string, { type?: string }> | undefined
      return Boolean(map?.[sessionID])
    } catch {
      return false // endpoint unavailable → fall back to idle-bounded polling
    }
  }

  async interrupt(role: AgentRole): Promise<void> {
    const sessionID = this.sessions.get(role)
    if (!sessionID || !this.host) return
    try {
      await this.host.sessions.interrupt({ sessionID, continue: false })
    } catch {
      /* session may already be finished */
    }
  }

  async interruptAll(): Promise<void> {
    for (const role of this.sessions.keys()) await this.interrupt(role)
  }

  async close(): Promise<void> {
    this.closed = true
    // Never orphan billable in-flight runs: a run ending (failure, budget,
    // shutdown) kills its remaining sessions. On success nothing is running.
    await this.interruptAll().catch(() => undefined)
    this.sessions.clear()
    if (this.host) {
      const host = this.host
      this.host = undefined
      await host.close().catch(() => undefined)
    }
  }

  /** Port hook: register the live activity observer (spinner/UI). */
  activityFeed(cb: (info: AgentActivity) => void): void {
    this.activityObservers.push(cb)
  }

  private emitActivity(info: AgentActivity): void {
    if (this.opts.onActivity) this.opts.onActivity(info)
    for (const cb of this.activityObservers) {
      try {
        cb(info)
      } catch {
        /* a UI observer must never break the run */
      }
    }
  }

  /**
   * Ledger feed: stream server events and map `session.usage.updated` events
   * to ledger entries. Strict ownership — only sessions this run created are
   * attributed; the stream is server-global and foreign sessions (the user's
   * own opencode work) must never pollute the ledger. Shape handling lives in
   * usage.ts (fixtures: test/runtime-usage.spec.ts).
   */
  private async consumeEvents(): Promise<void> {
    const host = this.host
    if (!host || !this.run) return
    const run = this.run
    const owned = (sid: string): AgentRole | undefined => {
      for (const [role, s] of this.sessions) if (s === sid) return role
      return undefined
    }
    const tracker = this.opts.onActivity || this.activityObservers.length > 0
      ? new ActivityTracker({ owned, onActivity: (info) => this.emitActivity(info) })
      : undefined
    // v2 event sources wait for every subscriber to accept each event — slow
    // work inside this loop stalls the stream. Accept immediately, process
    // serially off-loop (ordering preserved: ledger appends stay in sequence).
    let drain: Promise<void> = Promise.resolve()
    try {
      for await (const raw of host.events.subscribe()) {
        if (this.closed || !this.host) break
        for (const [role, sid] of this.sessions) this.roleBySession.set(sid, role)
        const entry = this.opts.ledger
          ? usageEntryFromEvent(raw, this.roleBySession, {
              runId: run.runId,
              ticket: run.ticket,
              modelFor: (role) => {
                const ref = this.modelRef(role)
                return ref ? `${ref.providerID}/${ref.id}` : undefined
              },
            })
          : undefined
        const obs = tracker
        drain = drain
          .then(async () => {
            if (this.closed) return
            if (entry) await this.opts.ledger!.record(entry)
            obs?.observe(raw)
          })
          .catch(() => undefined)
      }
    } catch {
      // event stream ended or host closed — nothing to do
    }
    await drain.catch(() => undefined)
  }
}

/**
 * Live model catalog without instantiating a runtime session — `Service.ensure()`
 * reuses (or starts) the shared background service, then `GET /api/model` is read
 * tolerantly. Used by runtime preflight and by `whipper doctor`.
 */
export async function liveModelCatalog(): Promise<CatalogEntry[]> {
  const { Service } = (await import("@opencode/client/service")) as unknown as {
    Service: { ensure(): Promise<{ url: string }>; headers(endpoint: { url: string }): Record<string, string> | undefined }
  }
  const endpoint = await Service.ensure()
  return fetchCatalog(endpoint.url, Service.headers(endpoint))
}

/** Unwrap client envelopes ({data:[...]}) and tolerate already-array responses. */
function normalizeMessageList(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === "object") {
    for (const key of ["data", "messages", "items"]) {
      const value = (raw as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

/**
 * Defensive extraction of the last assistant message text. Real V2 shape:
 * `{ type: "assistant", content: [{ type: "reasoning" | "text", text }], ... }`
 * — but older `role`/`parts`/`text` shapes are tolerated. Error-carrying
 * assistant messages throw ModelCallFailedError (terminal for this attempt).
 */
export function lastAssistantText(raw: unknown): string {
  const messages = normalizeMessageList(raw)
  let sawError: unknown
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, any>
    const info = msg.info ?? {}
    const role = msg.role ?? msg.type ?? info.role ?? info.type
    if (role !== "assistant") continue
    const err = msg.error ?? info.error
    if (err) {
      sawError = err
      continue
    }
    if (typeof msg.text === "string" && msg.text.trim()) return msg.text
    const parts = msg.parts ?? msg.content ?? info.parts ?? info.content
    if (Array.isArray(parts)) {
      const text = parts
        .filter((p: any) => (p.type ?? p.kind) === "text" && typeof (p.text ?? "") === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  if (sawError) {
    const detail = typeof sawError === "string" ? sawError : JSON.stringify(sawError)
    throw new ModelCallFailedError(detail.slice(0, 400))
  }
  throw new Error("opencode runtime: no assistant message in session context (session may have failed)")
}
