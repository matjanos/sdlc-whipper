#!/usr/bin/env node
import path from "node:path"
import { loadDotEnv, loadConfig, resolveModel } from "./config.js"
import { flagBool, flagString, parseArgs } from "./util/args.js"
import { createLogger } from "./util/log.js"
import { createDeps, type RuntimeMode } from "./adapters/index.js"
import { buildStatus } from "./conductor/status.js"
import { deliverTask, runTick } from "./conductor/tick.js"
import { setProgressDisabled } from "./util/progress.js"
import { installShutdownHandlers, isShuttingDown } from "./util/shutdown.js"
import { releaseTickLock } from "./util/lock.js"
import { runInit } from "./cli/init.js"
import type { AgentRole } from "./types.js"
import {
  renderDeliveryResult,
  renderDeliveryStart,
  renderError,
  renderHarnesses,
  renderHelp,
  renderHitch,
  renderLedger,
  renderRunStart,
  renderRunSummary,
  renderStatus,
  shouldUseColor,
} from "./cli/ui.js"

const VERSION = "0.1.0"

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const args = parseArgs(argv)
  const color = shouldUseColor(args.flags)
  const ui = { color }
  if (argv.includes("-v") || flagBool(args.flags, "version")) {
    console.log(`whipper ${VERSION}`)
    return
  }
  if (!args.command || argv.includes("-h") || flagBool(args.flags, "help")) {
    console.log(renderHelp(ui))
    return
  }
  const aliases: Record<string, string> = {
    crack: "tick",
    run: "tick",
    hit: "deliver",
    cockpit: "serve",
    costs: "ledger",
  }
  const command = aliases[args.command] ?? args.command
  loadDotEnv()
  const debug = flagBool(args.flags, "debug")
  const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
  const configPath = flagString(args.flags, "config")
  const dryRun = flagBool(args.flags, "dry-run")
  setProgressDisabled(!color)

  try {
    if (command === "init") {
      await runInit(args.flags)
      return
    }
    const config = await loadConfig(configPath)
    const runtimeFlag = flagString(args.flags, "runtime") as RuntimeMode | undefined

    switch (command) {
      case "harness": {
        const roles: AgentRole[] = ["groomer", "split", "researcher", "council", "executor", "reviewer", "tester"]
        const rows = roles.map((role) => ({
          role,
          modelClass: config.raw.agents[role]?.model,
          model: resolveModel(config, role),
          steps: config.raw.agents[role]?.steps,
        }))
        if (flagBool(args.flags, "json")) console.log(JSON.stringify(rows, null, 2))
        else console.log(renderHarnesses(rows, ui))
        break
      }
      case "hitch": {
        const deps = createDeps(config, log, { runtime: "none" })
        const workspace = await deps.tracker.discoverWorkspace()
        const report = {
          project: path.basename(config.repoRoot),
          configPath: config.configPath,
          team: workspace.teamKey,
          harnesses: 7,
          adapters: config.raw.adapters,
        }
        if (flagBool(args.flags, "json")) console.log(JSON.stringify(report, null, 2))
        else console.log(renderHitch(report, ui))
        break
      }
      case "status": {
        const deps = createDeps(config, log, { runtime: "none" })
        const report = await buildStatus(deps)
        if (flagBool(args.flags, "json")) console.log(JSON.stringify(report, null, 2))
        else console.log(renderStatus(report, ui))
        break
      }
      case "tick": {
        const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
        if (flagBool(args.flags, "no-groom")) {
          deps.config.raw.phases["groom"] = { enabled: false }
        }
        installShutdownHandlers({
          onInterrupt: () => {
            void deps.runtime.interruptAll()
            releaseTickLock(config.whipperDir)
          },
        })
        console.log(renderRunStart(config.repoRoot, deps.dryRun, ui))
        const report = await runTick(deps)
        const rollup = await deps.ledger.rollup("ticket")
        console.log(renderRunSummary(report.candidates, rollup, ui))
        if (isShuttingDown()) log.warn("run stopped by user — in-progress work stays in the worktree; safe to re-run")
        break
      }
      case "deliver": {
        const key = args.positional[0]
        if (!key) throw new Error("hit: ticket key required, e.g. `whipper hit LIN-123`")
        const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
        installShutdownHandlers({
          onInterrupt: () => {
            void deps.runtime.interruptAll()
          },
        })
        await deps.tracker.discoverWorkspace()
        const ticket = await deps.tracker.getTicket(key)
        console.log(renderDeliveryStart(ticket.key, ticket.title, deps.dryRun, ui))
        const status = await deliverTask(deps, ticket)
        console.log(renderDeliveryResult(ticket.key, status, ui, deps.dryRun))
        break
      }
      case "ledger": {
        const deps = createDeps(config, log, { runtime: "none" })
        const by = (flagString(args.flags, "by") ?? "ticket") as "ticket" | "phase" | "run" | "agent"
        const ticket = flagString(args.flags, "ticket")
        const rows = await deps.ledger.rollup(by, ticket ? { ticket } : undefined)
        console.log(renderLedger(by, rows, ui))
        break
      }
      case "serve": {
        const port = Number(flagString(args.flags, "port") ?? 4747)
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port: ${port}`)
        const deps = createDeps(config, log, { runtime: "none" })
        const { createCockpitServer } = await import("./conductor/server.js")
        await createCockpitServer(deps, { port })
        console.log(`\nWHIPPER  cockpit ready\n${config.repoRoot}\nPress Ctrl+C to stop.`)
        break
      }
      default:
        throw new Error(`Unknown command “${args.command}”. Run \`whipper --help\` to see the trail map.`)
    }
  } catch (err) {
    console.error(renderError((err as Error).message ?? String(err), ui))
    if (debug) console.error((err as Error).stack)
    process.exit(1)
  }
}

void main()
