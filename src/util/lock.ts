import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Advisory file lock preventing overlapping ticks. Stale locks (older than
 * staleMs) are broken — a crashed tick leaves nothing important behind since
 * durable state lives in the tracker + git.
 */
export async function withTickLock<T>(
  lockDir: string,
  staleMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  mkdirSync(lockDir, { recursive: true })
  const lockPath = path.join(lockDir, "tick.lock")
  if (existsSync(lockPath)) {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; ts: number }
    const age = Date.now() - parsed.ts
    if (age < staleMs) {
      throw new Error(
        `another tick appears to be running (pid ${parsed.pid}, started ${Math.round(age / 1000)}s ago)`,
      )
    }
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
