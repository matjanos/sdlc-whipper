import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Default config generation for `whipper init`. Pure object construction and
 * fs — no prompts, no CLI concerns (the interactive layer lives in
 * `src/cli/init.ts`). The defaults mirror `examples/sdlc.config.json`; they are
 * spelled out in code so a stock install can always regenerate them and so the
 * schema can never drift from the template unnoticed.
 */

export interface InitOptions {
  /** Linear team key, e.g. "LAW". */
  team?: string
  /** Vercel preview project name. */
  previewProject?: string
  /** All-fakes adapter set (offline demo flow). */
  fake?: boolean
}

export interface BuiltConfig {
  config: Record<string, unknown>
  /** Config fields left as placeholders because no flag provided a value. */
  placeholders: string[]
}

const TEAM_PLACEHOLDER = "TEAM"
const PROJECT_PLACEHOLDER = "your-project"

const TRACKER_MAP = {
  selected: "label:sdlc-selected",
  needsInfo: "label:needs-info",
  inProgress: "state:In Progress",
  inReview: "state:In Review",
  done: "state:Done",
  cancelled: "state:Canceled",
}

/** Build a schema-valid default config; report the fields left as placeholders. */
export function buildConfig(opts: InitOptions = {}): BuiltConfig {
  const team = opts.team ?? TEAM_PLACEHOLDER
  const previewProject = opts.previewProject ?? PROJECT_PLACEHOLDER
  const placeholders: string[] = []
  if (opts.team === undefined) placeholders.push("tracker.team")
  if (opts.previewProject === undefined) placeholders.push("preview.project")

  const adapters = opts.fake
    ? { tracker: "fake", codehost: "fake", preview: "fake", runtime: "fake" }
    : { tracker: "linear", codehost: "github", preview: "vercel", runtime: "opencode" }

  return {
    placeholders,
    config: {
      adapters,
      repo: { baseBranch: "main", branchPrefix: "sdlc/" },
      worktrees: { directory: "../worktrees" },
      tracker: { team, map: TRACKER_MAP },
      preview: {
        urlTemplate: "https://pr-{n}-{project}.vercel.app",
        project: previewProject,
        readyTimeoutMs: 15 * 60_000,
        pollMs: 10_000,
      },
      models: {
        reasoner: "anthropic/claude-sonnet-4-5#high",
        workhorse: "anthropic/claude-haiku-4",
      },
      agents: {
        groomer: { model: "reasoner" },
        split: { model: "reasoner" },
        researcher: { model: "reasoner" },
        council: { model: "reasoner" },
        executor: { model: "workhorse" },
        reviewer: { model: "reasoner" },
        tester: { model: "workhorse" },
      },
      budget: {
        maxParallelDeliveries: 2,
        perTaskUsd: 15,
        perTaskTokens: 4_000_000,
        maxLoopRounds: 3,
      },
      phases: { test: { enabled: true } },
      ledger: { directory: ".ledger" },
      dryRun: false,
    },
  }
}

const GITIGNORE_LINES = ["# sdlc-whipper", ".whipper/runs/", ".whipper/state.json", ".ledger/"]

/**
 * Append the whipper scratch-dir block to `<dir>/.gitignore` — once, and only
 * the lines not already present. Missing .gitignore → no-op (never create one
 * unrequested). Returns whether the file was modified.
 */
export function applyGitignore(dir: string): boolean {
  const file = path.join(dir, ".gitignore")
  if (!existsSync(file)) return false
  const existing = readFileSync(file, "utf8")
  const lines = existing.split("\n").map((l) => l.trim())
  const missing = GITIGNORE_LINES.filter((line) => !lines.includes(line))
  if (missing.length === 0) return false
  const prefix = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n"
  writeFileSync(file, `${existing}${prefix}${missing.join("\n")}\n`)
  return true
}
