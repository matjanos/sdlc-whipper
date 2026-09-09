import { execFile } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll } from "vitest"
import { loadConfig, type ResolvedConfig } from "../src/config.js"
import { createDeps, type DepsOverrides } from "../src/adapters/index.js"
import { FakeTracker } from "../src/adapters/tracker-fake/index.js"
import { FakeCodeHost } from "../src/adapters/codehost-fake/index.js"
import { FakePreview } from "../src/adapters/preview-fake/index.js"
import { FakeRuntime } from "../src/adapters/runtime-fake/index.js"
import { JsonlLedger } from "../src/adapters/ledger-jsonl/index.js"
import type { ConductorDeps } from "../src/conductor/deps.js"
import type { Ticket } from "../src/types.js"
import { createLogger } from "../src/util/log.js"

const exec = promisify(execFile)

export const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

/** A real throwaway git repo with a .whipper/config.json — worktree flows need real git. */
export async function makeTempRepo(configOverrides: Record<string, unknown> = {}): Promise<{ dir: string; config: ResolvedConfig }> {
  const dir = path.join(tmpdir(), `sdlc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  tempDirs.push(dir)
  mkdirSync(path.join(dir, ".whipper"), { recursive: true })
  await exec("git", ["init", "-b", "main"], { cwd: dir })
  await exec("git", ["config", "user.email", "test@test.test"], { cwd: dir })
  await exec("git", ["config", "user.name", "test"], { cwd: dir })
  writeFileSync(path.join(dir, "README.md"), "# test repo\n")
  await exec("git", ["add", "-A"], { cwd: dir })
  await exec("git", ["commit", "-m", "init"], { cwd: dir })
  writeFileSync(
    path.join(dir, ".whipper", "config.json"),
    JSON.stringify({
      adapters: { tracker: "fake", codehost: "fake", preview: "fake", runtime: "fake" },
      tracker: { team: "TST", map: { selected: "label:selected", needsInfo: "label:needs-info" } },
      preview: { project: "test-project" },
      models: { reasoner: "test/reasoner", workhorse: "test/workhorse" },
      // unique per temp repo — otherwise worktrees collide across tests
      worktrees: { directory: path.join(dir, "wt") },
      phases: { groom: { enabled: false } },
      ...configOverrides,
    }),
  )
  const config = await loadConfig(path.join(dir, ".whipper", "config.json"))
  return { dir, config }
}

export interface FakeDeps {
  deps: ConductorDeps
  tracker: FakeTracker
  codehost: FakeCodeHost
  preview: FakePreview
  runtime: FakeRuntime
}

export function wireFakes(
  config: ResolvedConfig,
  tickets: Ticket[],
  overrides: Omit<DepsOverrides, "tracker" | "codehost" | "preview" | "runtimeInstance"> & {
    runtimeScript?: import("../src/adapters/runtime-fake/index.js").FakeRuntimeOptions["script"]
  } = {},
): FakeDeps {
  const tracker = new FakeTracker({ tickets })
  const codehost = new FakeCodeHost()
  const preview = new FakePreview()
  const ledger = new JsonlLedger(config.ledgerDir)
  const runtime = new FakeRuntime({ script: overrides.runtimeScript, ledger })
  const deps = createDeps(config, createLogger("error"), {
    ...overrides,
    tracker,
    codehost,
    preview,
    runtimeInstance: runtime,
    ledger,
  })
  return { deps, tracker, codehost, preview, runtime }
}

export function ticket(partial: Partial<Ticket> & { key: string; title?: string }): Ticket {
  return {
    key: partial.key,
    title: partial.title ?? `Ticket ${partial.key}`,
    description: partial.description ?? "Do the thing.",
    comments: partial.comments ?? [],
    labels: partial.labels ?? ["selected"],
    state: partial.state ?? "backlog",
    relations: partial.relations ?? [],
  }
}
