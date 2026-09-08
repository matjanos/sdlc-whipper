import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Advisory file lock preventing overlapping ticks. A lock is stale when its
 * owner is dead (checked via signal-0 liveness) or older than staleMs — a
 * crashed tick leaves nothing important behind since durable state lives in
 * the tracker + git.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" // alive but not ours
  }
}

/** Release the tick lock if this process owns it. Safe to call repeatedly. */
export function releaseTickLock(lockDir: string): void {
  const lockPath = path.join(lockDir, "tick.lock")
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }
    if (parsed.pid !== process.pid) return // not ours — never break a live peer's lock
    unlinkSync(lockPath)
  } catch {
    /* lock already gone or unreadable */
  }
}

export async function withTickLock<T>(
  lockDir: string,
  staleMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(lockDir, { recursive: true })
  const lockPath = path.join(lockDir, "tick.lock")
  if (existsSync(lockPath)) {
    let parsed: { pid: number; ts: number } | undefined
    try {
      parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; ts: number }
    } catch {
      parsed = undefined // corrupt lock — treat as stale below
    }
    const ownerAlive = parsed ? isProcessAlive(parsed.pid) : false
    const age = parsed ? Date.now() - parsed.ts : Infinity
    if (parsed && ownerAlive && age < staleMs) {
      throw new Error(
        `another tick appears to be running (pid ${parsed.pid}, started ${Math.round(age / 1000)}s ago). ` +
          `If that is wrong (crashed run), remove ${lockPath} and re-try.`,
      )
    }
    // dead owner, corrupt file, or beyond stale age — take over
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
  try {
    return await fn()
  } finally {
    if (existsSync(lockPath)) {
      try {
        const current = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }
        if (current.pid === process.pid) unlinkSync(lockPath)
      } catch {
        /* lock already gone */
      }
    }
  }
}
