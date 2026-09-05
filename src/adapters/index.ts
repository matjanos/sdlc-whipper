import type { ResolvedConfig } from "../config.js"
import type { ConductorDeps } from "../conductor/deps.js"
import { Budget } from "../conductor/budget.js"
import type { Logger } from "../util/log.js"
import { JsonlLedger } from "./ledger-jsonl/index.js"
import { LinearTracker } from "./tracker-linear/index.js"
import { LinearMcpTracker } from "./tracker-linear-mcp/index.js"
import { FakeTracker } from "./tracker-fake/index.js"
import { GitHubCodeHost } from "./codehost-github/index.js"
import { FakeCodeHost } from "./codehost-fake/index.js"
import { VercelPreview } from "./preview-vercel/index.js"
import { VercelMcpPreview } from "./preview-vercel-mcp/index.js"
import { FakePreview } from "./preview-fake/index.js"
import { OpenCodeRuntime } from "./runtime-opencode/index.js"
import { FakeRuntime, type FakeRuntimeOptions } from "./runtime-fake/index.js"
import type { AgentRuntime, CodeHost, LedgerStore, PreviewEnvironment, TicketTracker } from "../ports/index.js"

export type RuntimeMode = "opencode" | "fake" | "none"

export interface DepsOverrides {
  runtime?: RuntimeMode
  dryRun?: boolean
  /** Injected fakes — used by tests and the offline demo mode. */
  tracker?: TicketTracker
  codehost?: CodeHost
  preview?: PreviewEnvironment
  runtimeInstance?: AgentRuntime
  fakeRuntime?: FakeRuntimeOptions
  ledger?: LedgerStore
}

class NoRuntime implements AgentRuntime {
  async open(): Promise<void> {
    throw new Error("runtime 'none': no agent runtime configured (status command needs none)")
  }
  async prompt(): Promise<string> {
    throw new Error("runtime 'none': no agent runtime configured")
  }
  async interrupt(): Promise<void> {}
  async interruptAll(): Promise<void> {}
  async close(): Promise<void> {}
}

/**
 * Composition root: adapters are selected by config (`adapters.*`), all port
 * implementations are wired here, and nothing else in the core knows vendor
 * names. Swapping Jira in = write adapters/tracker-jira + flip config.
 */
export function createDeps(config: ResolvedConfig, log: Logger, overrides: DepsOverrides = {}): ConductorDeps {
  const raw = config.raw

  const tracker: TicketTracker =
    overrides.tracker ??
    (raw.adapters.tracker === "linear"
      ? new LinearTracker({ team: raw.tracker.team, map: raw.tracker.map })
      : raw.adapters.tracker === "linear-mcp"
        ? new LinearMcpTracker({ team: raw.tracker.team, map: raw.tracker.map })
        : new FakeTracker())

  const codehost: CodeHost =
    overrides.codehost ??
    (raw.adapters.codehost === "github"
      ? new GitHubCodeHost({ cwd: config.repoRoot })
      : new FakeCodeHost())

  const preview: PreviewEnvironment =
    overrides.preview ??
    (raw.adapters.preview === "vercel"
      ? new VercelPreview({
          urlTemplate: raw.preview.urlTemplate,
          project: raw.preview.project,
          pollMs: raw.preview.pollMs,
        })
      : raw.adapters.preview === "vercel-mcp"
        ? new VercelMcpPreview({
            urlTemplate: raw.preview.urlTemplate,
            project: raw.preview.project,
            projectId: process.env["VERCEL_PROJECT_ID"],
            teamId: process.env["VERCEL_TEAM_ID"],
            pollMs: raw.preview.pollMs,
          })
        : new FakePreview())

  const ledger = overrides.ledger ?? new JsonlLedger(config.ledgerDir)

  const runtimeMode = overrides.runtime ?? raw.adapters.runtime
  const runtime: AgentRuntime =
    overrides.runtimeInstance ??
    (runtimeMode === "opencode"
      ? new OpenCodeRuntime({ config, fallbackDirectory: config.repoRoot, ledger })
      : runtimeMode === "fake"
        ? new FakeRuntime({ ...overrides.fakeRuntime, ledger })
        : new NoRuntime())

  const budget = new Budget(
    { tokens: raw.budget.perTaskTokens, costUsd: raw.budget.perTaskUsd },
    ledger,
  )

  return {
    config,
    tracker,
    codehost,
    preview,
    runtime,
    ledger,
    budget,
    log,
    dryRun: overrides.dryRun ?? raw.dryRun,
  }
}
