import type { ResolvedConfig } from "../config.js"
import { mustRun } from "../util/exec.js"

export async function hasCommits(worktree: string, baseBranch: string): Promise<boolean> {
  const { stdout } = await mustRun("git rev-list", "git", ["rev-list", "--count", `${baseBranch}..HEAD`], {
    cwd: worktree,
  })
  return Number(stdout.trim()) > 0
}

export async function hasUncommittedChanges(worktree: string): Promise<boolean> {
  const { stdout } = await mustRun("git status", "git", ["status", "--porcelain"], { cwd: worktree })
  return stdout.trim().length > 0
}

/** What the reviewer sees: committed diff vs base, plus uncommitted work on top. */
export async function diffFor(worktree: string, baseBranch: string): Promise<string> {
  const committed = await mustRun("git diff (committed)", "git", ["diff", `${baseBranch}...HEAD`], {
    cwd: worktree,
  })
  const uncommitted = await mustRun("git diff (working)", "git", ["diff", "HEAD"], { cwd: worktree })
  const untracked = await mustRun("git status", "git", ["status", "--porcelain"], { cwd: worktree })
  const parts: string[] = []
  if (committed.stdout.trim()) parts.push(committed.stdout)
  if (uncommitted.stdout.trim()) parts.push(uncommitted.stdout)
  if (untracked.stdout.trim()) {
    parts.push(`# Untracked files\n${untracked.stdout.trim().split("\n").map((l) => `# ${l}`).join("\n")}`)
  }
  return parts.join("\n\n") || "(no changes)"
}

async function commitIdentity(worktree: string): Promise<string[]> {
  const args: string[] = []
  try {
    const { stdout } = await mustRun("git config user.email", "git", ["config", "user.email"], { cwd: worktree })
    if (!stdout.trim()) throw new Error("empty")
  } catch {
    args.push("-c", "user.name=sdlc-whipper", "-c", "user.email=whipper@localhost")
  }
  return args
}

/** Stage everything except conductor/runtime scratch dirs, then commit. */
export async function commitAll(worktree: string, message: string): Promise<void> {
  // `git add -A` silently skips ignored files. The reset afterwards unstages
  // the scratch dirs for target repos that do NOT ignore them. Exclude
  // pathspecs (`:(exclude).opencode`) cannot be used here: they abort the add
  // with exit 1 when those dirs ARE gitignored — which is the recommended
  // target-repo setup — so publishing would fail on every such repo.
  await mustRun("git add", "git", ["add", "-A", "--", "."], { cwd: worktree })
  await mustRun("git reset", "git", ["reset", "-q", "--", ".opencode", ".sdlc"], { cwd: worktree })
  const identity = await commitIdentity(worktree)
  await mustRun("git commit", "git", [...identity, "commit", "-m", message], { cwd: worktree })
}

export async function push(worktree: string, branch: string): Promise<void> {
  await mustRun("git push", "git", ["push", "-u", "origin", branch], { cwd: worktree })
}
