import { execFile } from "node:child_process"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { makeTempRepo } from "./helpers.js"

const exec = promisify(execFile)

/**
 * Regression for the Clerc migration: kebab-case flags (--dry-run,
 * --preview-project) must reach command handlers as camelCase ctx.flags.
 * The definition keys are camelCase; Clerc maps CLI --dry-run onto them.
 * Spawned end-to-end because the bug lived exactly in the parsing boundary.
 */
describe("CLI flag parsing (spawned, offline)", () => {
  it("maps --dry-run onto the tick handler's dryRun flag", async () => {
    const { dir } = await makeTempRepo()
    const tickets = path.join(dir, "tickets.json")
    await writeFile(tickets, "[]")
    const { stdout } = await exec(
      "tsx",
      [path.resolve(import.meta.dirname, "../src/cli.ts"), "crack", "--dry-run", "--config", path.join(dir, ".whipper", "config.json")],
      {
        cwd: dir,
        env: { ...process.env, SDL_FAKE_TICKETS: tickets },
      },
    )
    expect(stdout).toContain("🎬 dry run")
    expect(stdout).toContain("🏁 RIDE COMPLETE")
  }, 30_000)
})
