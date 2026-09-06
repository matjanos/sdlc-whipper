import { existsSync } from "node:fs"
import path from "node:path"
import type { ResolvedConfig } from "../config.js"
import { mustRun } from "../util/exec.js"

export function branchName(config: ResolvedConfig, ticketKey: string): string {
  return `${config.raw.repo.branchPrefix}${ticketKey}`
}

export function worktreeDir(config: ResolvedConfig, ticketKey: string): string {
  return path.join(config.worktreesDir, ticketKey.toLowerCase())
}

/** Idempotent: reuse an existing worktree (state re-derived from tracker+git, so crashes are free). */
export async function ensureWorktree(
  config: ResolvedConfig,
  ticketKey: string,
): Promise<string> {
  const dir = worktreeDir(config, ticketKey)
  if (existsSync(dir)) return dir
  const branch = branchName(config, ticketKey)
  // A previous run may have left the branch behind (crash, escalation, cleanup).
  // Reuse it — it holds that run's partial work — instead of failing on -b.
  const branchExists = await revParseVerify(config.repoRoot, `refs/heads/${branch}`)
  await mustRun(
    `git worktree add for ${ticketKey}`,
    "git",
    branchExists
      ? ["worktree", "add", dir, branch]
      : ["worktree", "add", "-b", branch, dir, config.raw.repo.baseBranch],
    { cwd: config.repoRoot },
  )
  return dir
}

async function revParseVerify(cwd: string, ref: string): Promise<boolean> {
  try {
    await mustRun(`git rev-parse ${ref}`, "git", ["rev-parse", "--verify", "--quiet", ref], { cwd })
    return true
  } catch {
    return false
  }
}

export async function removeWorktree(config: ResolvedConfig, ticketKey: string): Promise<void> {
  const dir = worktreeDir(config, ticketKey)
  if (!existsSync(dir)) return
  await mustRun(`git worktree remove ${ticketKey}`, "git", ["worktree", "remove", "--force", dir], {
    cwd: config.repoRoot,
  })
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const { stdout } = await mustRun("git rev-parse", "git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir })
    return stdout.trim() === "true"
  } catch {
    return false
  }
}
