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
  await mustRun(
    `git worktree add for ${ticketKey}`,
    "git",
    ["worktree", "add", "-b", branchName(config, ticketKey), dir, config.raw.repo.baseBranch],
    { cwd: config.repoRoot },
  )
  return dir
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
