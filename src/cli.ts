#!/usr/bin/env node
import { loadDotEnv, loadConfig } from "./config.js"
import { flagBool, flagString, parseArgs } from "./util/args.js"
import { createLogger } from "./util/log.js"
import { createDeps, type RuntimeMode } from "./adapters/index.js"
import { buildStatus, formatStatus } from "./conductor/status.js"
import { deliverTask, runTick } from "./conductor/tick.js"

const HELP = `sdlc — autonomous SDLC conductor

Usage:
  sdlc status  [--config <path>] [--json]      read-only: what a tick would do and why
  sdlc tick    [--config <path>] [--dry-run] [--runtime opencode|fake] [--no-groom]
  sdlc deliver <KEY> [--config <path>] [--dry-run] [--runtime opencode|fake]
  sdlc ledger  [--config <path>] [--ticket KEY] [--by ticket|phase|run|agent]

Environment: LINEAR_API_KEY (graphql adapter) or LINEAR_MCP_TOKEN (mcp adapter).
Demo/offline: --runtime fake with "adapters": {"tracker":"fake",...} in config.

Docs: README.md — ports/adapters, pipelines, budgets, the context firewall.`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const command = args.command
  if (!command || flagBool(args.flags, "help")) {
    console.log(HELP)
    process.exit(command && command !== "--help" ? 1 : 0)
  }
  loadDotEnv()
  const debug = flagBool(args.flags, "debug")
  const log = createLogger(debug ? "debug" : "info")
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
        else console.log(formatStatus(report))
        break
      }
      case "tick": {
        const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
        if (flagBool(args.flags, "no-groom")) {
          deps.config.raw.phases["groom"] = { enabled: false }
        }
        log.info(`tick start${deps.dryRun ? " (DRY RUN)" : ""} — repo ${config.repoRoot}`)
        const report = await runTick(deps)
        log.info(`tick done: ${report.candidates.filter((c) => c.status !== "skipped").length} delivered, ${report.candidates.filter((c) => c.status === "skipped").length} skipped`)
        for (const c of report.candidates) {
          log.info(`  ${c.key}: ${c.status}${c.reason ? ` — ${c.reason}` : ""}`)
        }
        const rollup = await deps.ledger.rollup("ticket")
        for (const row of rollup) log.info(`  ledger ${row.key}: $${row.costUsd.toFixed(2)}, ${(row.tokens / 1000).toFixed(1)}k tokens, ${row.runs} calls`)
        break
      }
      case "deliver": {
        const key = args.positional[0]
        if (!key) throw new Error("deliver: ticket key required, e.g. `sdlc deliver LIN-123`")
        const deps = createDeps(config, log, { runtime: runtimeFlag, dryRun })
        await deps.tracker.discoverWorkspace()
        const ticket = await deps.tracker.getTicket(key)
        log.info(`delivering ${ticket.key}: ${ticket.title}${deps.dryRun ? " (DRY RUN)" : ""}`)
        const status = await deliverTask(deps, ticket)
        log.info(`deliver ${ticket.key}: ${status}`)
        break
      }
      case "ledger": {
        const deps = createDeps(config, log, { runtime: "none" })
        const by = (flagString(args.flags, "by") ?? "ticket") as "ticket" | "phase" | "run" | "agent"
        const ticket = flagString(args.flags, "ticket")
        const rows = await deps.ledger.rollup(by, ticket ? { ticket } : undefined)
        if (rows.length === 0) {
          console.log("ledger is empty")
          break
        }
        console.log(`${by.padEnd(24)} ${"calls".padStart(6)} ${"tokens".padStart(14)} ${"costUsd".padStart(9)}`)
        for (const r of rows) {
          console.log(
            `${r.key.slice(0, 24).padEnd(24)} ${String(r.runs).padStart(6)} ${String(r.tokens).padStart(14)} ${r.costUsd.toFixed(2).padStart(9)}`,
          )
        }
        break
      }
      default:
        console.error(`unknown command: ${command}\n\n${HELP}`)
        process.exit(1)
    }
  } catch (err) {
    log.error((err as Error).message ?? String(err))
    if (debug) console.error((err as Error).stack)
    process.exit(1)
  }
}

void main()
