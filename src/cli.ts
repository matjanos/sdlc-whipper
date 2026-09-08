#!/usr/bin/env node
import { loadDotEnv, loadConfig } from "./config.js"
import { flagBool, flagString, parseArgs } from "./util/args.js"
import { createLogger } from "./util/log.js"
import { createDeps, type RuntimeMode } from "./adapters/index.js"
import { buildStatus } from "./conductor/status.js"
import { deliverTask, runTick } from "./conductor/tick.js"
import {
  renderDeliveryResult,
  renderDeliveryStart,
  renderError,
  renderHelp,
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
  const aliases: Record<string, string> = { hit: "tick", run: "tick", cockpit: "serve", costs: "ledger" }
  const command = aliases[args.command] ?? args.command
  loadDotEnv()
  const debug = flagBool(args.flags, "debug")
  const log = createLogger(debug ? "debug" : "info", { pretty: !debug })
  const configPath = flagString(args.flags, "config")
  const dryRun = flagBool(args.flags, "dry-run")

  try {
    const config = await loadConfig(configPath)
    const runtimeFlag = flagString(args.flags, "runtime") as RuntimeMode | undefined

    switch (command) {
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
        console.log(renderRunStart(config.repoRoot, deps.dryRun, ui))
        const report = await runTick(deps)
        const rollup = await deps.ledger.rollup("ticket")
        console.log(renderRunSummary(report.candidates, rollup, ui))
        break
      }
      case "deliver": {
        const key = args.positional[0]
        if (!key) throw new Error("deliver: ticket key required, e.g. `sdlc deliver LIN-123`")
        const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
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
