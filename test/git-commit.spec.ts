import { execFile } from "node:child_process"
import { writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { commitAll } from "../src/git/repo.js"
import { makeTempRepo } from "./helpers.js"

const exec = promisify(execFile)

/**
 * publish-phase commit hygiene, verified with real git (no LLM): conductor and
 * runtime scratch dirs (.opencode, .sdlc) must never land in the commit — both
 * when the target repo ignores them (the recommended setup) and when it does
 * not. Regression for the failed LAW-1 publish: exclude pathspecs abort
 * `git add` with exit 1 when the dirs are gitignored.
 */
describe("commitAll scratch-dir hygiene (real git)", () => {
  async function stagedFiles(worktree: string): Promise<string[]> {
    const { stdout } = await exec("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: worktree })
    return stdout.trim().split("\n").filter(Boolean)
  }

  it("never stages scratch dirs that are gitignored", async () => {
    const { dir } = await makeTempRepo()
    await writeFile(path.join(dir, ".gitignore"), "node_modules/\n.opencode/\n.sdlc/\n")
    await mkdir(path.join(dir, ".opencode"), { recursive: true })
    await mkdir(path.join(dir, ".sdlc"), { recursive: true })
    await writeFile(path.join(dir, "src.js"), "export ok = 1\n")
    await writeFile(path.join(dir, ".opencode", "opencode.json"), "{}")
    await writeFile(path.join(dir, ".sdlc", "state.json"), "{}")
    await exec("git", ["add", "-A"], { cwd: dir })
    await exec("git", ["commit", "-m", "init"], { cwd: dir })

    await writeFile(path.join(dir, "src.js"), "export ok = 2\n")
    await writeFile(path.join(dir, ".opencode", "opencode.json"), '{"x":1}')
    await commitAll(dir, "sdlc: change")

    expect(await stagedFiles(dir)).toEqual(["src.js"])
  })

  it("excludes scratch dirs from the commit even when the target repo does not ignore them", async () => {
    const { dir } = await makeTempRepo()
    await writeFile(path.join(dir, "src.js"), "export ok = 1\n")
    await exec("git", ["add", "-A"], { cwd: dir })
    await exec("git", ["commit", "-m", "init"], { cwd: dir })

    await mkdir(path.join(dir, ".opencode"), { recursive: true })
    await mkdir(path.join(dir, ".sdlc"), { recursive: true })
    await writeFile(path.join(dir, "feature.js"), "export feature = 1\n")
    await writeFile(path.join(dir, ".opencode", "opencode.json"), "{}")
    await writeFile(path.join(dir, ".sdlc", "state.json"), "{}")
    await commitAll(dir, "sdlc: feature")

    expect(await stagedFiles(dir)).toEqual(["feature.js"])
  })
})
