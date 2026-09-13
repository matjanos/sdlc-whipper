import { execFile } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { buildDoctorReport, modelClassProblems, runDoctor } from "../src/doctor.js"
import { branchName, worktreeDir } from "../src/git/worktrees.js"
import { FakeTracker } from "../src/adapters/tracker-fake/index.js"
import { makeTempRepo } from "./helpers.js"

const exec = promisify(execFile)
const cli = path.resolve(import.meta.dirname, "../src/cli.ts")

const check = (report: { checks: { name: string }[] }, name: string) => {
  const found = report.checks.find((c) => c.name === name)
  if (!found) throw new Error(`no check named ${name} in [${report.checks.map((c) => c.name).join(", ")}]`)
  return found
}

describe("buildDoctorReport (pure)", () => {
  it("fails iff any check failed — na never fails", () => {
    expect(buildDoctorReport([{ name: "a", status: "ok", detail: "" }]).ok).toBe(true)
    expect(buildDoctorReport([{ name: "a", status: "na", detail: "n/a" }]).ok).toBe(true)
    expect(buildDoctorReport([{ name: "a", status: "ok", detail: "" }, { name: "b", status: "fail", detail: "x" }]).ok).toBe(false)
  })

  it("keeps the given check order", () => {
    const checks = [
      { name: "tracker", status: "na" as const, detail: "" },
      { name: "config", status: "ok" as const, detail: "" },
    ]
    expect(buildDoctorReport(checks).checks.map((c) => c.name)).toEqual(["tracker", "config"])
  })
})

describe("modelClassProblems (pure)", () => {
  it("reports role + class exactly for unknown classes", async () => {
    const { config } = await makeTempRepo({ agents: { executor: { model: "wizard" } } })
    expect(modelClassProblems(config)).toEqual([{ role: "executor", modelClass: "wizard" }])
  })

  it("skips roles without a pinned model", async () => {
    const { config } = await makeTempRepo({ agents: { executor: { model: "reasoner" }, reviewer: { steps: 10 } } })
    expect(modelClassProblems(config)).toEqual([])
  })
})

describe("doctor checks (offline)", () => {
  it("collapses an unloadable config into a single config failure", async () => {
    const report = await runDoctor({ configPath: path.join("definitely", "missing", "config.json") })
    expect(report.ok).toBe(false)
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({ name: "config", status: "fail" })
  })

  it("marks fake adapters n/a and passes the rest of the all-fake repo", async () => {
    const { config } = await makeTempRepo()
    const report = await runDoctor({ configPath: config.configPath })
    expect(report.ok).toBe(true)
    expect(check(report, "tracker").status).toBe("na")
    expect(check(report, "codehost").status).toBe("na")
    expect(check(report, "models").status).toBe("na")
    expect(check(report, "model-catalog").status).toBe("na")
    expect(check(report, "ledger").status).toBe("ok")
    expect(check(report, "worktrees").status).toBe("ok")
  })

  it("fails the tracker check with a .env.example hint when linear keys are stripped", async () => {
    const { config } = await makeTempRepo({ adapters: { tracker: "linear", codehost: "fake", preview: "fake", runtime: "fake" } })
    const saved = { apiKey: process.env["LINEAR_API_KEY"], mcpToken: process.env["LINEAR_MCP_TOKEN"] }
    delete process.env["LINEAR_API_KEY"]
    delete process.env["LINEAR_MCP_TOKEN"]
    try {
      const report = await runDoctor({ configPath: config.configPath })
      const tracker = check(report, "tracker")
      expect(tracker.status).toBe("fail")
      expect(`${tracker.detail} ${tracker.hint ?? ""}`).toContain(".env.example")
    } finally {
      if (saved.apiKey === undefined) delete process.env["LINEAR_API_KEY"]
      else process.env["LINEAR_API_KEY"] = saved.apiKey
      if (saved.mcpToken === undefined) delete process.env["LINEAR_MCP_TOKEN"]
      else process.env["LINEAR_MCP_TOKEN"] = saved.mcpToken
    }
  })

  it("okays a linear tracker via an injected tracker", async () => {
    const { config } = await makeTempRepo({ adapters: { tracker: "linear", codehost: "fake", preview: "fake", runtime: "fake" } })
    const report = await runDoctor({
      configPath: config.configPath,
      probes: { depsOverrides: { tracker: new FakeTracker() } },
    })
    expect(check(report, "tracker").status).toBe("ok")
    expect(report.ok).toBe(true)
  })

  it("probes codehost auth through the injected gh probe", async () => {
    const host = await makeTempRepo({ adapters: { tracker: "fake", codehost: "github", preview: "fake", runtime: "fake" } })
    const passed = await runDoctor({ configPath: host.config.configPath, probes: { ghAuth: async () => ({ stdout: "ok", stderr: "" }) } })
    expect(check(passed, "codehost").status).toBe("ok")

    const denied = await runDoctor({
      configPath: host.config.configPath,
      probes: {
        ghAuth: async () => {
          const err = new Error("not logged in") as NodeJS.ErrnoException
          throw err
        },
      },
    })
    const failed = check(denied, "codehost")
    expect(failed.status).toBe("fail")
    expect(failed.hint).toContain("gh auth login")
  })

  it("names role and class when an agent references an unknown model class", async () => {
    const { config } = await makeTempRepo({ agents: { executor: { model: "wizard" } } })
    const report = await runDoctor({ configPath: config.configPath })
    expect(report.ok).toBe(false)
    const models = check(report, "models")
    expect(models.status).toBe("fail")
    expect(models.detail).toContain("executor")
    expect(models.detail).toContain("wizard")
  })

  it("validates model refs against the injected catalog", async () => {
    const catalog = [
      { providerID: "test", id: "reasoner" },
      { providerID: "test", id: "workhorse" },
    ]
    const agents = { executor: { model: "reasoner" }, reviewer: { model: "workhorse" } }
    const live = await makeTempRepo({ adapters: { tracker: "fake", codehost: "fake", preview: "fake", runtime: "opencode" }, agents })
    const passed = await runDoctor({
      configPath: live.config.configPath,
      probes: { modelCatalog: async () => catalog },
    })
    expect(check(passed, "model-catalog").status).toBe("ok")

    const badRef = await makeTempRepo({ adapters: { tracker: "fake", codehost: "fake", preview: "fake", runtime: "opencode" }, agents })
    const failed = await runDoctor({
      configPath: badRef.config.configPath,
      probes: { modelCatalog: async () => [] },
    })
    const catalogCheck = check(failed, "model-catalog")
    expect(catalogCheck.status).toBe("fail")
    expect(catalogCheck.detail).toContain("executor")

    const down = await makeTempRepo({ adapters: { tracker: "fake", codehost: "fake", preview: "fake", runtime: "opencode" }, agents })
    const unreachable = await runDoctor({
      configPath: down.config.configPath,
      probes: {
        modelCatalog: async () => {
          throw new Error("connection refused")
        },
      },
    })
    const unavailable = check(unreachable, "model-catalog")
    expect(unavailable.status).toBe("fail")
    expect(unavailable.detail).toContain("connection refused")
  })

  it("fails the ledger check when the probe file cannot be written", async () => {
    const { config } = await makeTempRepo()
    mkdirSync(config.ledgerDir, { recursive: true })
    mkdirSync(path.join(config.ledgerDir, ".doctor-probe")) // directory in the way → EISDIR
    const report = await runDoctor({ configPath: config.configPath })
    expect(check(report, "ledger").status).toBe("fail")
    expect(report.ok).toBe(false)
  })

  it("leaves no probe worktree or branch behind", async () => {
    const { dir, config } = await makeTempRepo()
    const report = await runDoctor({ configPath: config.configPath })
    expect(check(report, "worktrees").status).toBe("ok")
    expect(existsSync(worktreeDir(config, "whipper-doctor-probe"))).toBe(false)
    await expect(
      exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName(config, "whipper-doctor-probe")}`], { cwd: dir }),
    ).rejects.toBeTruthy()
  })

  it("fails the worktree check on a bogus base branch", async () => {
    const { config } = await makeTempRepo({ repo: { baseBranch: "no-such-branch" } })
    const report = await runDoctor({ configPath: config.configPath })
    const worktrees = check(report, "worktrees")
    expect(worktrees.status).toBe("fail")
    expect(`${worktrees.detail} ${worktrees.hint ?? ""}`).toContain("baseBranch")
  })
})

describe("doctor CLI (spawned, offline)", () => {
  const configOf = (dir: string) => path.join(dir, ".whipper", "config.json")

  it("exits 0 on the all-fake repo with an ok report covering every area", async () => {
    const { dir } = await makeTempRepo()
    const { stdout } = await exec("tsx", [cli, "doctor", "--config", configOf(dir), "--json"], { cwd: dir })
    const report = JSON.parse(stdout)
    expect(report.ok).toBe(true)
    for (const c of report.checks) expect(["ok", "na"]).toContain(c.status)
    for (const area of ["config", "tracker", "codehost", "models", "ledger", "worktrees"]) {
      expect(report.checks.map((c: { name: string }) => c.name)).toContain(area)
    }
  }, 30_000)

  it("renders a friendly report with ✅ and literal n/a on the all-fake repo", async () => {
    const { dir } = await makeTempRepo()
    const { stdout } = await exec("tsx", [cli, "doctor", "--config", configOf(dir)], { cwd: dir })
    expect(stdout).toContain("PREFLIGHT")
    expect(stdout).toContain("✅")
    expect(stdout).toContain("n/a")
    expect(stdout).toContain("all clear")
  }, 30_000)

  it("exits 1 naming role and class for an unknown model class", async () => {
    const { dir } = await makeTempRepo({ agents: { executor: { model: "wizard" } } })
    try {
      await exec("tsx", [cli, "doctor", "--config", configOf(dir), "--json"], { cwd: dir })
      throw new Error("expected nonzero exit")
    } catch (err) {
      const e = err as { code?: number; stdout: string }
      expect(e.code).toBe(1)
      const report = JSON.parse(e.stdout)
      expect(report.ok).toBe(false)
      const models = report.checks.find((c: { name: string }) => c.name === "models")
      expect(models.detail).toContain("executor")
      expect(models.detail).toContain("wizard")
    }
  }, 30_000)

  it("exits 1 with a .env.example hint when linear keys are stripped", async () => {
    const { dir } = await makeTempRepo({ adapters: { tracker: "linear", codehost: "fake", preview: "fake", runtime: "fake" } })
    const env = { ...process.env } as Record<string, string | undefined>
    delete env["LINEAR_API_KEY"]
    delete env["LINEAR_MCP_TOKEN"]
    try {
      await exec("tsx", [cli, "doctor", "--config", configOf(dir), "--json"], { cwd: dir, env: env as NodeJS.ProcessEnv })
      throw new Error("expected nonzero exit")
    } catch (err) {
      const e = err as { code?: number; stdout: string }
      expect(e.code).toBe(1)
      expect(e.stdout).toContain('"status": "fail"')
      expect(e.stdout).toContain(".env.example")
    }
  }, 30_000)

  it("lists the doctor command in help", async () => {
    const { stdout } = await exec("tsx", [cli, "--help"], {})
    expect(stdout).toContain("doctor")
  }, 30_000)
})
