#!/usr/bin/env node
import path from "node:path"
import { Cli } from "clerc"
import { loadDotEnv, loadConfig, resolveModel, type ResolvedConfig } from "./config.js"
import { createLogger } from "./util/log.js"
import { createDeps, type RuntimeMode } from "./adapters/index.js"
import { buildStatus } from "./conductor/status.js"
import { deliverTask, runTick } from "./conductor/tick.js"
import { setProgressDisabled } from "./util/progress.js"
import { installShutdownHandlers, isShuttingDown } from "./util/shutdown.js"
import { releaseTickLock } from "./util/lock.js"
import { runDoctor } from "./doctor.js"
import { runInit } from "./cli/init.js"
import type { AgentRole } from "./types.js"
import { renderDeliveryResult, renderDeliveryStart, renderDoctor, renderError, renderHarnesses, renderHitch, renderLedger, renderRunStart, renderRunSummary, renderStatus } from "./cli/ui.js"

const VERSION = "0.1.0"

/** Flags every config-bearing command accepts. */
const COMMON_FLAGS = {
  config: { type: String, description: "Use a specific .whipper/config.json" },
  json: { type: Boolean, description: "Machine-readable output" },
  plain: { type: Boolean, description: "Disable color and terminal styling" },
  debug: { type: Boolean, description: "Include diagnostic detail" },
} as const

interface CommonFlags {
  config?: string
  json?: boolean
  plain?: boolean
  debug?: boolean
}

/** Color/env setup shared by every command (safe to run before config load). */
async function uiContext(flags: CommonFlags): Promise<{ color: boolean; debug: boolean }> {
  loadDotEnv()
  const color = Boolean(process.stdout.isTTY && process.env["NO_COLOR"] === undefined && !flags.plain)
  setProgressDisabled(!color)
  return { color, debug: Boolean(flags.debug) }
}

/** Color/env setup + config load shared by all config-bearing commands. */
async function commandContext(flags: CommonFlags): Promise<{ color: boolean; debug: boolean; config: ResolvedConfig }> {
  const ui = await uiContext(flags)
  const config = await loadConfig(flags.config)
  return { ...ui, config }
}

const cli = Cli() // built-in help + version plugins
  .scriptName("whipper")
  .description("🐎 a steady hand for your agent team — whipper sets the route, pace, and limits. Merging always stays human. 🤝")
  .version(VERSION)
  .command("init", "🐎 saddle up this repo: generate .whipper/config.json", {
    flags: {
      team: { type: String, description: "Tracker team key (e.g. LAW)" },
      previewProject: { type: String, description: "Preview project name" },
      fake: { type: Boolean, description: "Use the all-fakes adapter set (offline demo)" },
      force: { type: Boolean, description: "Overwrite an existing config" },
      yes: { type: Boolean, description: "Non-interactive: accept flags and defaults" },
      ...COMMON_FLAGS,
    },
  })
  .on("init", (ctx) => runInit(ctx.flags))
  .command("status", "🧭 ready, blocked, waiting, and in-flight work", { flags: COMMON_FLAGS })
  .on("status", async (ctx) => {
    const { color, config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const deps = createDeps(config, log, { runtime: "none" })
    const report = await buildStatus(deps)
    if (ctx.flags.json) console.log(JSON.stringify(report, null, 2))
    else console.log(renderStatus(report, { color }))
  })
  .command("harness", "🛠️  inspect each agent's role, model, and step limit", { flags: COMMON_FLAGS })
  .on("harness", async (ctx) => {
    const { color, config } = await commandContext(ctx.flags)
    const roles: AgentRole[] = ["groomer", "split", "researcher", "council", "executor", "reviewer", "tester"]
    const rows = roles.map((role) => ({
      role,
      modelClass: config.raw.agents[role]?.model,
      model: resolveModel(config, role),
      steps: config.raw.agents[role]?.steps,
    }))
    if (ctx.flags.json) console.log(JSON.stringify(rows, null, 2))
    else console.log(renderHarnesses(rows, { color }))
  })
  .command("hitch", "🪢 verify the team is connected to this project", { flags: COMMON_FLAGS })
  .on("hitch", async (ctx) => {
    const { color, config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const deps = createDeps(config, log, { runtime: "none" })
    const workspace = await deps.tracker.discoverWorkspace()
    const report = {
      project: path.basename(config.repoRoot),
      configPath: config.configPath,
      team: workspace.teamKey,
      harnesses: 7,
      adapters: config.raw.adapters,
    }
    if (ctx.flags.json) console.log(JSON.stringify(report, null, 2))
    else console.log(renderHitch(report, { color }))
  })
  .command("doctor", "🩺 one-shot preflight: adapters, keys, models, ledger, worktrees", { flags: COMMON_FLAGS })
  .on("doctor", async (ctx) => {
    const { color } = await uiContext(ctx.flags)
    const report = await runDoctor({ configPath: ctx.flags.config })
    if (ctx.flags.json) console.log(JSON.stringify(report, null, 2))
    else console.log(renderDoctor(report, { color }))
    process.exitCode = report.ok ? 0 : 1
  })
  .command("serve", "🎛️  open the live project cockpit", {
    flags: { port: { type: Number, description: "Port to listen on", default: 4747 }, ...COMMON_FLAGS },
    alias: "cockpit",
  })
  .on("serve", async (ctx) => {
    const { config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const deps = createDeps(config, log, { runtime: "none" })
    const { createCockpitServer } = await import("./conductor/server.js")
    await createCockpitServer(deps, { port: ctx.flags.port ?? 4747 })
    console.log(`\nWHIPPER  cockpit ready\n${config.repoRoot}\nPress Ctrl+C to stop.`)
  })
  .command("ledger", "🧾 cost and token usage by ticket, phase, run, or agent", {
    flags: {
      by: { type: String, description: "Rollup dimension: ticket | phase | run | agent", default: "ticket" },
      ticket: { type: String, description: "Filter to one ticket key" },
      ...COMMON_FLAGS,
    },
    alias: "costs",
  })
  .on("ledger", async (ctx) => {
    const { color, config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const deps = createDeps(config, log, { runtime: "none" })
    const by = (ctx.flags.by ?? "ticket") as "ticket" | "phase" | "run" | "agent"
    const ticket = ctx.flags.ticket
    const rows = await deps.ledger.rollup(by, ticket ? { ticket } : undefined)
    console.log(renderLedger(by, rows, { color }))
  })
  .command("tick", "⚡ crack the whip: reconcile and dispatch the team", {
    flags: {
      dryRun: { type: Boolean, description: "Walk the route without outside-world mutations" },
      noGroom: { type: Boolean, description: "Skip the grooming phase for this run" },
      runtime: { type: String, description: "Override the configured agent runtime" },
      ...COMMON_FLAGS,
    },
    alias: ["crack", "run"],
  })
  .on("tick", async (ctx) => {
    const { color, config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const dryRun = ctx.flags.dryRun === true
    const runtimeFlag = ctx.flags.runtime as RuntimeMode | undefined
    const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
    if (ctx.flags.noGroom === true) {
      deps.config.raw.phases["groom"] = { enabled: false }
    }
    installShutdownHandlers({
      onInterrupt: () => {
        void deps.runtime.interruptAll()
        releaseTickLock(config.whipperDir)
      },
    })
    console.log(renderRunStart(config.repoRoot, deps.dryRun, { color }))
    const report = await runTick(deps)
    const rollup = await deps.ledger.rollup("ticket")
    console.log(renderRunSummary(report.candidates, rollup, { color }))
    if (isShuttingDown()) log.warn("run stopped by user — in-progress work stays in the worktree; safe to re-run")
  })
  .command("deliver", "🎯 target one durable ticket directly", {
    parameters: ["<key>"],
    flags: {
      dryRun: { type: Boolean, description: "Walk the route without outside-world mutations" },
      runtime: { type: String, description: "Override the configured agent runtime" },
      ...COMMON_FLAGS,
    },
    alias: "hit",
  })
  .on("deliver", async (ctx) => {
    const { color, config, debug } = await commandContext(ctx.flags)
    const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
    const dryRun = ctx.flags.dryRun === true
    const runtimeFlag = ctx.flags.runtime as RuntimeMode | undefined
    const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
    installShutdownHandlers({
      onInterrupt: () => {
        void deps.runtime.interruptAll()
      },
    })
    await deps.tracker.discoverWorkspace()
    const ticket = await deps.tracker.getTicket(ctx.parameters.key)
    console.log(renderDeliveryStart(ticket.key, ticket.title, deps.dryRun, { color }))
    const status = await deliverTask(deps, ticket)
    console.log(renderDeliveryResult(ticket.key, status, { color }, deps.dryRun))
  })
  .errorHandler((err) => {
    const debug = process.argv.includes("--debug")
    console.error(renderError((err as Error).message ?? String(err), { color: process.stdout.isTTY === true }))
    if (debug) console.error((err as Error).stack)
    process.exit(1)
  })

void cli.parse()
