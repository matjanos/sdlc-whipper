import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { applyGitignore, buildConfig } from "../src/init.js"
import { runInit } from "../src/cli/init.js"
import { loadConfig } from "../src/config.js"

const exec = promisify(execFile)

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

/** Real git repo: round-trip validation requires a git toplevel. */
async function makeGitDir(): Promise<string> {
  const dir = path.join(tmpdir(), `init-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  tempDirs.push(dir)
  mkdirSync(dir, { recursive: true })
  await exec("git", ["init", "-b", "main"], { cwd: dir })
  await exec("git", ["config", "user.email", "test@test.test"], { cwd: dir })
  await exec("git", ["config", "user.name", "test"], { cwd: dir })
  return dir
}

function flags(...pairs: [string, string | boolean][]): Map<string, string | boolean> {
  return new Map(pairs)
}

describe("buildConfig", () => {
  it("round-trips through the zod schema for both adapter sets", async () => {
    for (const fake of [true, false]) {
      const dir = await makeGitDir()
      const file = path.join(dir, ".whipper", "config.json")
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(buildConfig({ fake }).config, null, 2))
      const config = await loadConfig(file)
      expect(config.raw.adapters.tracker).toBe(fake ? "fake" : "linear")
      expect(config.raw.tracker.team).toBe("TEAM")
      expect(config.raw.preview.project).toBe("your-project")
    }
  })

  it("reports unfilled fields as placeholders", () => {
    expect(buildConfig().placeholders).toEqual(["tracker.team", "preview.project"])
    expect(buildConfig({ team: "LAW" }).placeholders).toEqual(["preview.project"])
    expect(buildConfig({ team: "LAW", previewProject: "my-app" }).placeholders).toEqual([])
  })
})

describe("runInit (non-interactive)", () => {
  it("writes a valid config and honors flags", async () => {
    const dir = await makeGitDir()
    await runInit(
      flags(["yes", true], ["team", "LAW"], ["preview-project", "my-app"], ["fake", true], ["config", path.join(dir, ".whipper", "config.json")]),
    )
    const config = await loadConfig(path.join(dir, ".whipper", "config.json"))
    expect(config.raw.adapters.tracker).toBe("fake")
    expect(config.raw.tracker.team).toBe("LAW")
    expect(config.raw.preview.project).toBe("my-app")
  })

  it("refuses to overwrite without --force, overwrites with it", async () => {
    const file = path.join((await makeGitDir()), ".whipper", "config.json")
    const base = flags(["yes", true], ["config", file])
    await runInit(base)
    const first = JSON.parse(readFileSync(file, "utf8"))
    await expect(runInit(base)).rejects.toThrow(/--force/)
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(first) // untouched
    await runInit(flags(["yes", true], ["config", file], ["force", true], ["team", "ENG"]))
    expect(JSON.parse(readFileSync(file, "utf8")).tracker.team).toBe("ENG")
  })
})

describe("applyGitignore", () => {
  it("appends once, is idempotent, and skips a missing .gitignore", async () => {
    const dir = await makeGitDir()
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n")
    expect(applyGitignore(dir)).toBe(true)
    const once = readFileSync(path.join(dir, ".gitignore"), "utf8")
    expect(once).toContain(".whipper/runs/")
    expect(applyGitignore(dir)).toBe(false)
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe(once)
    expect(applyGitignore(await makeGitDir())).toBe(false)

    // end-to-end: a forced re-run must not duplicate the gitignore block
    await runInit(flags(["yes", true], ["force", true], ["config", path.join(dir, ".whipper", "config.json")]))
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8").match(/\.whipper\/runs\//g)).toHaveLength(1)
  })

  it("assists the repo root .gitignore, not the .whipper directory", async () => {
    const dir = await makeGitDir()
    writeFileSync(path.join(dir, ".gitignore"), "")
    await runInit(flags(["yes", true], ["config", path.join(dir, ".whipper", "config.json")]))
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toContain(".whipper/runs/")
    expect(existsSync(path.join(dir, ".whipper", ".gitignore"))).toBe(false)
  })
})
