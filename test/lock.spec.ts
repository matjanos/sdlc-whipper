import { execFile } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { releaseTickLock, withTickLock } from "../src/util/lock.js"

const exec = promisify(execFile)

function lockDir(): string {
  const dir = path.join(tmpdir(), `whipper-lock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** A definitely-dead pid: spawn a process and wait for it to exit. */
async function deadPid(): Promise<number> {
  const child = exec("true")
  await child
  return child.pid
}

describe("withTickLock liveness takeover", () => {
  it("breaks the lock when the owning pid is dead", async () => {
    const dir = lockDir()
    const pid = await deadPid()
    writeFileSync(path.join(dir, "tick.lock"), JSON.stringify({ pid, ts: Date.now() }))

    const result = await withTickLock(dir, 30 * 60_000, async () => "delivered")
    expect(result).toBe("delivered")
  })

  it("still blocks while the owning pid is alive and the lock is fresh", async () => {
    const dir = lockDir()
    writeFileSync(path.join(dir, "tick.lock"), JSON.stringify({ pid: process.pid, ts: Date.now() }))

    await expect(withTickLock(dir, 30 * 60_000, async () => "never")).rejects.toThrow(/another tick appears to be running/)
  })

  it("treats a corrupt lock file as stale and takes over", async () => {
    const dir = lockDir()
    writeFileSync(path.join(dir, "tick.lock"), "{not json")

    await expect(withTickLock(dir, 30 * 60_000, async () => "ok")).resolves.toBe("ok")
  })

  it("releaseTickLock removes only our own lock", async () => {
    const dir = lockDir()
    const lockPath = path.join(dir, "tick.lock")
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now() }))
    releaseTickLock(dir)
    expect(existsSync(lockPath)).toBe(false)

    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1_000_000, ts: Date.now() }))
    releaseTickLock(dir)
    expect(existsSync(lockPath)).toBe(true) // someone else's lock is untouched
  })
})
