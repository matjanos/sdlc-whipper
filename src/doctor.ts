import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadConfig, resolveModel, type ResolvedConfig } from "./config.js"
import { createDeps, type DepsOverrides } from "./adapters/index.js"
import { liveModelCatalog } from "./adapters/runtime-opencode/index.js"
import { invalidModelRefs, parseModelRef, type CatalogEntry, type ModelRef } from "./adapters/runtime-opencode/models.js"
import { branchName, ensureWorktree, removeWorktree, worktreeDir } from "./git/worktrees.js"
import { run, mustRun, type ExecResult } from "./util/exec.js"
import { createLogger } from "./util/log.js"
import type { AgentRole } from "./types.js"

export type DoctorStatus = "ok" | "fail" | "na"

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
  hint?: string
}

export interface DoctorReport {
  /** False iff any check failed — the CLI maps this to exit code 1. */
  ok: boolean
  checks: DoctorCheck[]
}

/** Pure assembly: stable check order, ok iff nothing failed (`na` never fails). */
export function buildDoctorReport(checks: DoctorCheck[]): DoctorReport {
  return { ok: checks.every((c) => c.status !== "fail"), checks }
}

export interface ModelClassProblem {
  role: AgentRole
  modelClass: string
}

/**
 * Every `agents.<role>.model` whose class is absent from `models`. Pure: the
 * unknown-class error from `resolveModel` becomes data a doctor check reports.
 */
export function modelClassProblems(config: ResolvedConfig): ModelClassProblem[] {
  const problems: ModelClassProblem[] = []
  for (const role of Object.keys(config.raw.agents) as AgentRole[]) {
    const modelClass = config.raw.agents[role]?.model
    if (!modelClass) continue
    try {
      resolveModel(config, role)
    } catch {
      problems.push({ role, modelClass })
    }
  }
  return problems
}

/** I/O seams for the doctor — real commands by default, fakes in tests. */
export interface DoctorProbes {
  /** Injected adapters (tests) — passed through to createDeps. */
  depsOverrides?: DepsOverrides
  /** Code-host auth probe; default runs `gh auth status`. */
  ghAuth?: () => Promise<ExecResult>
  /** Model catalog probe; default `liveModelCatalog()` against the opencode service. */
  modelCatalog?: () => Promise<CatalogEntry[]>
}

const msg = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const ENV_HINT = "keys live in .env — start from .env.example (cp .env.example .env)"

/**
 * One-shot preflight. Checks never throw: every failure becomes a DoctorCheck,
 * and a config that cannot load is a single-`config`-fail report, not a crash.
 */
export async function runDoctor(options: { configPath?: string; probes?: DoctorProbes } = {}): Promise<DoctorReport> {
  let config: ResolvedConfig
  try {
    config = await loadConfig(options.configPath)
  } catch (err) {
    return buildDoctorReport([
      { name: "config", status: "fail", detail: msg(err), hint: "fix .whipper/config.json or pass --config <path>" },
    ])
  }
  return buildDoctorReport(await runDoctorChecks(config, options.probes ?? {}))
}

/** Stable order: config, tracker, codehost, models, model-catalog, ledger, worktrees. */
export async function runDoctorChecks(config: ResolvedConfig, probes: DoctorProbes = {}): Promise<DoctorCheck[]> {
  const configCheck: DoctorCheck = {
    name: "config",
    status: "ok",
    detail: `${config.configPath} · repo root ${config.repoRoot}`,
  }
  const [tracker, codehost, models, modelCatalog, ledger, worktrees] = await Promise.all([
    trackerCheck(config, probes),
    codehostCheck(config, probes),
    Promise.resolve(modelsCheck(config)),
    modelCatalogCheck(config, probes),
    Promise.resolve(ledgerCheck(config)),
    worktreesCheck(config),
  ])
  return [configCheck, tracker, codehost, models, modelCatalog, ledger, worktrees]
}

async function trackerCheck(config: ResolvedConfig, probes: DoctorProbes): Promise<DoctorCheck> {
  if (config.raw.adapters.tracker === "fake") {
    return { name: "tracker", status: "na", detail: "n/a — fake tracker (offline demo)" }
  }
  try {
    const deps = createDeps(config, createLogger("error"), { runtime: "none", ...probes.depsOverrides })
    const workspace = await deps.tracker.discoverWorkspace()
    return { name: "tracker", status: "ok", detail: `team ${workspace.teamKey} reachable via ${config.raw.adapters.tracker}` }
  } catch (err) {
    return { name: "tracker", status: "fail", detail: msg(err), hint: ENV_HINT }
  }
}

async function codehostCheck(config: ResolvedConfig, probes: DoctorProbes): Promise<DoctorCheck> {
  if (config.raw.adapters.codehost === "fake") {
    return { name: "codehost", status: "na", detail: "n/a — fake code host (offline demo)" }
  }
  try {
    await (probes.ghAuth?.() ?? run("gh", ["auth", "status"], { timeoutMs: 10_000 }))
    return { name: "codehost", status: "ok", detail: "gh CLI authenticated" }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    const notInstalled = e.code === "ENOENT" || msg(err).includes("ENOENT")
    return {
      name: "codehost",
      status: "fail",
      detail: notInstalled ? "gh CLI not installed" : `gh auth status failed: ${msg(err)}`,
      hint: notInstalled ? "install the GitHub CLI (https://cli.github.com), then gh auth login" : "run gh auth login",
    }
  }
}

function modelsCheck(config: ResolvedConfig): DoctorCheck {
  const pinned = (Object.keys(config.raw.agents) as AgentRole[]).filter((role) => config.raw.agents[role]?.model)
  if (pinned.length === 0) {
    return { name: "models", status: "na", detail: "n/a — no agent pins a model class (runtimes use their defaults)" }
  }
  const problems = modelClassProblems(config)
  if (problems.length > 0) {
    return {
      name: "models",
      status: "fail",
      detail: problems.map((p) => `agents.${p.role}.model references unknown model class "${p.modelClass}"`).join("; "),
      hint: 'add the class to the models map (models."<class>" = provider/model) in .whipper/config.json',
    }
  }
  const classes = [...new Set(pinned.map((role) => config.raw.agents[role]?.model))].join(", ")
  return { name: "models", status: "ok", detail: `${pinned.length} pinned agent(s) resolve against models: ${classes}` }
}

async function modelCatalogCheck(config: ResolvedConfig, probes: DoctorProbes): Promise<DoctorCheck> {
  if (config.raw.adapters.runtime === "fake") {
    return { name: "model-catalog", status: "na", detail: "n/a — fake runtime (offline demo)" }
  }
  const refs: { role: AgentRole; parsed: ModelRef }[] = []
  const malformed: string[] = []
  for (const role of Object.keys(config.raw.agents) as AgentRole[]) {
    let concrete: string | undefined
    try {
      concrete = resolveModel(config, role)
    } catch {
      continue // unknown classes are the models check's finding, not this one's
    }
    if (!concrete) continue
    try {
      refs.push({ role, parsed: parseModelRef(concrete) })
    } catch (err) {
      malformed.push(`${role}: "${concrete}" — ${msg(err)}`)
    }
  }
  if (malformed.length > 0) {
    return {
      name: "model-catalog",
      status: "fail",
      detail: malformed.join("; "),
      hint: "model refs must be provider/id[#variant]",
    }
  }
  if (refs.length === 0) {
    return { name: "model-catalog", status: "na", detail: "n/a — no concrete model refs configured" }
  }
  let catalog: CatalogEntry[]
  try {
    catalog = probes.modelCatalog ? await probes.modelCatalog() : await liveModelCatalog()
  } catch (err) {
    return {
      name: "model-catalog",
      status: "fail",
      detail: `model catalog unavailable: ${msg(err)}`,
      hint: 'start the opencode service once (run `opencode`) or set adapters.runtime to "fake"',
    }
  }
  const problems = invalidModelRefs(refs, catalog)
  if (problems.length > 0) {
    return {
      name: "model-catalog",
      status: "fail",
      detail: problems.map((p) => `${p.role}: ${p.ref} — ${p.detail}`).join("; "),
      hint: "check models/agents in .whipper/config.json (see `opencode models`)",
    }
  }
  return { name: "model-catalog", status: "ok", detail: `${refs.length} model ref(s) in the live catalog (${catalog.length} models)` }
}

function ledgerCheck(config: ResolvedConfig): DoctorCheck {
  const probe = path.join(config.ledgerDir, ".doctor-probe")
  try {
    mkdirSync(config.ledgerDir, { recursive: true })
    writeFileSync(probe, "whipper doctor probe")
    try {
      unlinkSync(probe)
    } catch {
      /* best effort */
    }
    return { name: "ledger", status: "ok", detail: `${config.ledgerDir} is writable` }
  } catch (err) {
    return {
      name: "ledger",
      status: "fail",
      detail: `ledger dir not writable: ${msg(err)}`,
      hint: `check permissions on ledger.directory (${config.raw.ledger.directory})`,
    }
  }
}

async function worktreesCheck(config: ResolvedConfig): Promise<DoctorCheck> {
  const key = "whipper-doctor-probe"
  try {
    await mustRun("git worktree prune", "git", ["worktree", "prune"], { cwd: config.repoRoot })
    const dir = await ensureWorktree(config, key)
    if (!existsSync(dir)) throw new Error(`worktree dir missing after add: ${dir}`)
    return { name: "worktrees", status: "ok", detail: `worktrees.directory ${config.worktreesDir} accepts a probe worktree` }
  } catch (err) {
    return {
      name: "worktrees",
      status: "fail",
      detail: `worktree probe failed: ${msg(err)}`,
      hint: `check worktrees.directory (${config.raw.worktrees.directory}) and repo.baseBranch (${config.raw.repo.baseBranch})`,
    }
  } finally {
    try {
      await removeWorktree(config, key)
    } catch {
      /* best effort */
    }
    try {
      await mustRun("git branch -D", "git", ["branch", "-D", branchName(config, key)], { cwd: config.repoRoot })
    } catch {
      /* the probe branch may never have been created */
    }
  }
}
