import type { AgentRuntime, LedgerStore, PromptOptions, RunContext } from "../../ports/index.js"
import type { AgentRole, LedgerEntry, PromptParts } from "../../types.js"
import { resolveModel } from "../../config.js"
import { writeWorktreeAgentConfig, agentId } from "./agents.js"
import { isTransient } from "../../conductor/retry.js"
import { sleep } from "../../util/exec.js"

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
  /** Assistant-message polling window (agent runs can take minutes). */
  assistantPollTries?: number
  assistantPollMs?: number
}

/** The assistant message exists but carries a provider error — terminal for this attempt. */
export class ModelCallFailedError extends Error {
  constructor(detail: string) {
    super(`opencode runtime: model call failed inside the session — ${detail}`)
    this.name = "ModelCallFailedError"
  }
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
  private closed = false

  constructor(private readonly opts: OpenCodeRuntimeOptions) {}

  private directory(): string {
    return this.run?.worktree ?? this.opts.fallbackDirectory ?? process.cwd()
  }

  private async ensureHost(): Promise<SdkHost> {
    if (this.host) return this.host
    const [{ OpenCode }, { Service }] = (await Promise.all([
      import("@opencode-ai/client"),
      import("@opencode-ai/client/service"),
    ])) as unknown as [
      { OpenCode: { make(options: { baseUrl: string; headers?: Record<string, string> }): { session: SdkSessions; event: SdkEvents } } },
      { Service: { ensure(): Promise<{ url: string }>; headers(endpoint: { url: string }): Record<string, string> | undefined } },
    ]
    const endpoint = await Service.ensure()
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    })
    this.host = {
      sessions: client.session,
      events: client.event,
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
    this.closed = false
    if (run.worktree) {
      writeWorktreeAgentConfig(this.opts.config, run.worktree)
    }
    await this.ensureHost()
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
    return session.id
  }

  /** Parse `provider/id[#variant]` from config. */
  private modelRef(role: AgentRole): { providerID: string; id: string; variant?: string } | undefined {
    const ref = resolveModel(this.opts.config, role)
    if (!ref) return undefined
    const slash = ref.indexOf("/")
    if (slash <= 0) throw new Error(`opencode runtime: model ref "${ref}" must be provider/id`)
    const [providerID, rest] = [ref.slice(0, slash), ref.slice(slash + 1)]
    const hash = rest.indexOf("#")
    return hash > 0
      ? { providerID, id: rest.slice(0, hash), variant: rest.slice(hash + 1) }
      : { providerID, id: rest }
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
    return await this.awaitAssistant(sessionID, this.opts.assistantPollTries ?? 40, this.opts.assistantPollMs ?? 15_000)
  }

  /**
   * Poll session context until an assistant message exists. "No assistant yet"
   * keeps polling; an error-carrying assistant message is terminal (the server
   * already exhausted its provider retries).
   */
  private async awaitAssistant(sessionID: string, tries: number, intervalMs: number): Promise<string> {
    for (let i = 0; i < tries; i++) {
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
        /* no assistant message yet — keep polling */
      }
    }
    throw new Error(
      `opencode runtime: session produced no assistant message within the polling window (${tries} × ${intervalMs}ms)`,
    )
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
    this.sessions.clear()
    if (this.host) {
      const host = this.host
      this.host = undefined
      await host.close().catch(() => undefined)
    }
  }

  /**
   * Ledger feed: stream server events, pick token-usage-carrying messages,
   * attribute them to this run's roles via the sessionID→role map.
   * Event payload shape is defensive by design (M2 spike verifies it).
   */
  private async consumeEvents(): Promise<void> {
    const host = this.host
    if (!host || !this.opts.ledger || !this.run) return
    const roleBySession = new Map<string, AgentRole>()
    try {
      for await (const raw of host.events.subscribe()) {
        if (this.closed || !this.host) break
        const ev = raw as Record<string, any>
        const sessionID: string | undefined = ev.sessionID ?? ev.info?.sessionID ?? ev.properties?.sessionID
        if (sessionID) {
          for (const [role, sid] of this.sessions) if (sid === sessionID) roleBySession.set(sid, role)
        }
        const tokens = ev.tokens ?? ev.usage ?? ev.info?.tokens ?? ev.info?.usage
        if (!tokens || typeof tokens !== "object") continue
        const input = Number(tokens.input ?? tokens.inputTokens ?? 0)
        const output = Number(tokens.output ?? tokens.outputTokens ?? 0)
        if (input + output === 0) continue
        const role = (sessionID ? roleBySession.get(sessionID) : undefined) ?? "groomer"
        const entry: LedgerEntry = {
          runId: this.run.runId,
          ticket: this.run.ticket,
          phase: "tick",
          agent: role,
          model: typeof ev.model === "string" ? ev.model : ev.info?.model,
          ts: new Date().toISOString(),
          tokens: {
            input,
            output,
            cacheRead: Number(tokens.cacheRead ?? tokens.cache_read ?? 0) || undefined,
            cacheWrite: Number(tokens.cacheWrite ?? tokens.cache_write ?? 0) || undefined,
          },
          costUsd: null, // pricing: read from the model catalog once the event shape is verified (M2 spike)
          sessionId: sessionID,
        }
        await this.opts.ledger.record(entry)
      }
    } catch {
      // event stream ended or host closed — nothing to do
    }
  }
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
