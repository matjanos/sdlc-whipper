import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { AgentRole, LogicalState } from "./types.js"

const exec = promisify(execFile)

/** `label:sdlc-selected` or `state:In Progress` — logical marker → concrete tracker thing. */
export interface Selector {
  kind: "label" | "state"
  name: string
}

export function parseSelector(raw: string, context: string): Selector {
  const idx = raw.indexOf(":")
  if (idx <= 0) {
    throw new ConfigError(`${context}: selector must be "label:<name>" or "state:<name>", got "${raw}"`)
  }
  const kind = raw.slice(0, idx)
  const name = raw.slice(idx + 1)
  if (kind !== "label" && kind !== "state") {
    throw new ConfigError(`${context}: selector kind must be "label" or "state", got "${kind}"`)
  }
  return { kind, name }
}

const adapterName = z.enum(["linear", "linear-mcp", "fake"])
const codeHostName = z.enum(["github", "fake"])
const previewName = z.enum(["vercel", "vercel-mcp", "fake"])
const runtimeName = z.enum(["opencode", "fake"])
const agentRole = z.enum([
  "groomer",
  "split",
  "researcher",
  "council",
  "executor",
  "reviewer",
  "tester",
])

const schema = z.object({
  adapters: z
    .object({
      tracker: adapterName.default("linear"),
      codehost: codeHostName.default("github"),
      preview: previewName.default("vercel"),
      runtime: runtimeName.default("opencode"),
    })
    .default({}),
  repo: z
    .object({
      baseBranch: z.string().default("main"),
      branchPrefix: z.string().default("sdlc/"),
    })
    .default({}),
  worktrees: z.object({ directory: z.string().default("../worktrees") }).default({}),
  tracker: z.object({
    team: z.string(),
    /** Optional project scope: when set, the conductor only sees and moves tickets inside this tracker project. */
    project: z.string().optional(),
    /** logical marker → concrete selector. Defaults cover the common Linear setup; everything is overridable. */
    map: z
      .record(z.string(), z.string())
      .default({
        selected: "label:sdlc-selected",
        needsInfo: "label:needs-info",
        inProgress: "state:In Progress",
        inReview: "state:In Review",
        done: "state:Done",
        cancelled: "state:Canceled",
      }),
  }),
  preview: z.object({
    /** `{n}` → PR number, `{project}` → preview.project. */
    urlTemplate: z.string().default("https://pr-{n}-{project}.vercel.app"),
    project: z.string(),
    readyTimeoutMs: z.number().int().positive().default(15 * 60_000),
    pollMs: z.number().int().positive().default(10_000),
  }),
  /** model class → concrete provider/model id (with optional #variant). Agents reference classes, not ids. */
  models: z.record(z.string(), z.string()).default({}),
  agents: z
    .record(agentRole, z.object({ model: z.string().optional(), steps: z.number().int().positive().optional() }))
    .default({}),
  budget: z
    .object({
      maxParallelDeliveries: z.number().int().positive().default(2),
      perTaskUsd: z.number().positive().default(15),
      perTaskTokens: z.number().int().positive().default(4_000_000),
      maxLoopRounds: z.number().int().positive().default(3),
    })
    .default({}),
  phases: z
    .record(z.string(), z.object({ enabled: z.boolean().default(true), cadenceMinutes: z.number().positive().optional() }))
    .default({}),
  ledger: z.object({ directory: z.string().default(".ledger") }).default({}),
  dryRun: z.boolean().default(false),
})

export type RawConfig = z.output<typeof schema>

export interface ResolvedConfig {
  raw: RawConfig
  configPath: string
  /** Target repo root (git toplevel of the directory containing .whipper/config.json). */
  repoRoot: string
  /** Conductor scratch space inside the target repo: run state, artifacts, locks. Gitignore `.whipper/runs` + `.whipper/state.json`. */
  whipperDir: string
  artifactsDir: string
  worktreesDir: string
  ledgerDir: string
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigError"
  }
}

/** Find config: explicit path, else walk up from cwd looking for .whipper/config.json. */
export function discoverConfigPath(explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) throw new ConfigError(`config not found: ${explicit}`)
    return path.resolve(explicit)
  }
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, ".whipper", "config.json")
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) {
      throw new ConfigError(
        "no .whipper/config.json found — pass --config <path> or create one (see examples/sdlc.config.json)",
      )
    }
    dir = parent
  }
}

async function gitToplevel(from: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: from })
    return stdout.trim()
  } catch {
    throw new ConfigError(`no git repo found above ${from} — the target repo must be a git checkout`)
  }
}

export async function loadConfig(explicit?: string): Promise<ResolvedConfig> {
  const configPath = discoverConfigPath(explicit)
  let json: unknown
  try {
    json = JSON.parse(readFileSync(configPath, "utf8"))
  } catch (err) {
    throw new ConfigError(`failed to parse ${configPath}: ${(err as Error).message}`)
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`).join("\n")
    throw new ConfigError(`invalid config ${configPath}:\n${issues}`)
  }
  const repoRoot = await gitToplevel(path.dirname(configPath))
  const resolved: ResolvedConfig = {
    raw: parsed.data,
    configPath,
    repoRoot,
    whipperDir: path.join(repoRoot, ".whipper"),
    artifactsDir: path.join(repoRoot, ".whipper", "runs"),
    worktreesDir: path.resolve(repoRoot, parsed.data.worktrees.directory),
    ledgerDir: path.resolve(repoRoot, parsed.data.ledger.directory),
  }
  if (parsed.data.adapters.preview !== "fake" && !parsed.data.preview.urlTemplate) {
    throw new ConfigError("preview.urlTemplate is required for vercel preview adapters")
  }
  return resolved
}

/** Resolve an agent's concrete model id from its class reference. */
export function resolveModel(config: ResolvedConfig, role: AgentRole): string | undefined {
  const agent = config.raw.agents[role]
  if (agent?.model) {
    const concrete = config.raw.models[agent.model]
    if (!concrete) {
      throw new ConfigError(`agents.${role}.model references unknown model class "${agent.model}"`)
    }
    return concrete
  }
  return undefined
}

/** Selector for a logical marker (e.g. `selected`, `needsInfo`, or a LogicalState). */
export function selectorFor(config: ResolvedConfig, logical: string): Selector {
  const raw = config.raw.tracker.map[logical]
  if (!raw) {
    throw new ConfigError(`tracker.map has no entry for "${logical}"`)
  }
  return parseSelector(raw, `tracker.map.${logical}`)
}

/**
 * Project scope for every ticket query. With `tracker.project` set, whipper
 * operates inside one project — the team stays the unit of states/labels, but
 * backlog sweeps and delivery candidates never leak beyond the project fence.
 */
export function projectScope(config: ResolvedConfig): { project?: string } {
  const project = config.raw.tracker.project
  return project ? { project } : {}
}

/** All logical markers the tick loop listens for. */
export const LOGICAL_MARKERS: Record<string, LogicalState | "marker"> = {
  selected: "marker",
  needsInfo: "marker",
  inProgress: "inProgress",
  inReview: "inReview",
  done: "done",
  cancelled: "cancelled",
}

/** Minimal .env loader (KEY=VALUE lines) — real env wins. */
export function loadDotEnv(file = ".env"): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "")
    if (process.env[key] === undefined) process.env[key] = value
  }
}
