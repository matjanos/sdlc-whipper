import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import * as p from "@clack/prompts"
import { applyGitignore, buildConfig } from "../init.js"
import { loadConfig } from "../config.js"
import { flagBool, flagString } from "../util/args.js"

/**
 * `whipper init` — interactive when a TTY is attached and not opted out via
 * `--yes`; fully flag-driven otherwise (CI, pipes, tests). All decisions come
 * from the pure core in `src/init.ts`; this file is presentation + fs.
 */

type Flags = Map<string, string | boolean>

/** Unwrap a clack prompt result, turning Ctrl+C/esc into a clean exit. */
function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("init cancelled — nothing was written.")
    process.exit(0)
  }
  return value as T
}

export async function runInit(flags: Flags): Promise<void> {
  const interactive = process.stdout.isTTY === true && !flagBool(flags, "yes")
  const dest = path.resolve(flagString(flags, "config") ?? path.join(process.cwd(), ".whipper", "config.json"))
  const force = flagBool(flags, "force")

  let team = flagString(flags, "team")
  let previewProject = flagString(flags, "preview-project")
  let fake = flagBool(flags, "fake")

  if (interactive) {
    p.intro("🐎 whipper init — saddle up your target repo")
    if (!fake) {
      const mode = unwrap(
        await p.select({
          message: "Which harness should run in this repo?",
          options: [
            { value: "real", label: "Real agents", hint: "Linear + GitHub + Vercel + opencode" },
            { value: "fake", label: "Fake adapters", hint: "offline demo, no keys, no network" },
          ],
          initialValue: "real",
        }),
      )
      fake = mode === "fake"
    }
    if (team === undefined) {
      team = unwrap(
        await p.text({
          message: "Tracker team key",
          placeholder: "LAW",
          defaultValue: "TEAM",
        }),
      )
    }
    if (previewProject === undefined) {
      previewProject = unwrap(
        await p.text({
          message: "Preview project name",
          placeholder: "your-project",
          defaultValue: "your-project",
        }),
      )
    }
  }

  const exists = existsSync(dest)
  if (exists && !force) {
    if (!interactive) {
      throw new Error(`config already exists: ${dest} — pass --force to overwrite`)
    }
    const overwrite = unwrap(
      await p.confirm({
        message: `${dest} already exists. Overwrite?`,
        initialValue: false,
      }),
    )
    if (!overwrite) {
      p.cancel("init cancelled — nothing was written.")
      return
    }
  }

  const built = buildConfig({ team, previewProject, fake })

  const write = (): void => {
    mkdirSync(path.dirname(dest), { recursive: true })
    writeFileSync(dest, JSON.stringify(built.config, null, 2) + "\n")
    // Scratch dirs live next to the target repo's .gitignore: the parent of
    // .whipper for the stock layout, the config's own directory otherwise.
    const configDir = path.dirname(dest)
    applyGitignore(path.basename(configDir) === ".whipper" ? path.dirname(configDir) : configDir)
  }

  if (interactive) {
    const s = p.spinner()
    s.start(`writing ${dest}`)
    write()
    await loadConfig(dest) // round-trip: init must never emit an unparseable config
    s.stop(`wrote ${dest}`)
    for (const field of built.placeholders) {
      p.log.warn(`edit before first run: ${field}`)
    }
    if (!fake) {
      p.log.info("auth: LINEAR_API_KEY (or LINEAR_MCP_TOKEN) · gh auth login · model keys in your opencode user config")
    }
    p.outro(`next: whipper status → whipper crack --dry-run`)
  } else {
    write()
    await loadConfig(dest)
    console.log(`wrote ${dest}`)
    for (const field of built.placeholders) {
      console.log(`edit before first run: ${field}`)
    }
    if (!fake) {
      console.log("auth: LINEAR_API_KEY (or LINEAR_MCP_TOKEN) · gh auth login · model keys in your opencode user config")
    }
    console.log("next: whipper status → whipper crack --dry-run")
  }
}
