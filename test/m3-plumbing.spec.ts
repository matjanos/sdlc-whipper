import { execFile } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { Artifacts } from "../src/conductor/artifacts.js"
import { publishPhase } from "../src/phases/publish.js"
import { ensureWorktree } from "../src/git/worktrees.js"
import { makeTempRepo, ticket, wireFakes } from "./helpers.js"

const exec = promisify(execFile)

describe("M3 PR plumbing", () => {
  it("does not commit, push, or open a PR during a dry run", async () => {
    const { dir, config } = await makeTempRepo()
    const { deps, codehost } = wireFakes(config, [ticket({ key: "TST-DRY" })], { dryRun: true })
    const worktree = await ensureWorktree(config, "TST-DRY")
    writeFileSync(`${worktree}/feature.txt`, "practice change\n")
    const task = {
      ticket: ticket({ key: "TST-DRY" }),
      worktree,
      artifacts: new Artifacts(`${dir}/.sdlc/runs/TST-DRY`),
      deps,
      runId: "run_dry",
    }

    const result = await publishPhase.run!(task, {})
    expect(result).toEqual({ skipped: true })
    expect(codehost.calls.filter((call) => call.op === "openPR")).toHaveLength(0)
    expect(readFileSync(`${worktree}/feature.txt`, "utf8")).toBe("practice change\n")
    const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: worktree })
    expect(stdout).toContain("feature.txt")
  })

  it("publishes uncommitted executor edits and reuses the existing PR on rerun", async () => {
    const { dir, config } = await makeTempRepo()
    const bare = `${dir}-origin.git`
    mkdirSync(bare, { recursive: true })
    await exec("git", ["init", "--bare", "-q", bare])
    await exec("git", ["remote", "add", "origin", bare], { cwd: dir })

    const { deps, codehost } = wireFakes(config, [ticket({ key: "TST-1" })])
    const worktree = await ensureWorktree(config, "TST-1")
    writeFileSync(`${worktree}/feature.txt`, "implemented by executor\n")
    const task = {
      ticket: ticket({ key: "TST-1" }),
      worktree,
      artifacts: new Artifacts(`${dir}/.sdlc/runs/TST-1`),
      deps,
      runId: "run_m3",
    }

    const first = await publishPhase.run!(task, {})
    expect(first.skipped).toBe(false)
    expect(first.pr?.number).toBe(1)
    expect(codehost.calls.filter((c) => c.op === "openPR")).toHaveLength(1)
    expect(codehost.calls.filter((c) => c.op === "findOpenPR")).toHaveLength(1)

    const second = await publishPhase.run!(task, {})
    expect(second).toEqual(first)
    expect(codehost.calls.filter((c) => c.op === "openPR")).toHaveLength(1)
    expect(codehost.calls.filter((c) => c.op === "findOpenPR")).toHaveLength(2)
  })
})
