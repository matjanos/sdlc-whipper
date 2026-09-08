import type { StatusReport } from "../conductor/status.js"
import type { RunStatus } from "../types.js"
import { formatTokens, stamp } from "../util/format.js"

export interface UiOptions {
  color?: boolean
}

const esc = (code: number, text: string, enabled: boolean): string =>
  enabled ? `\u001B[${code}m${text}\u001B[0m` : text

const bold = (text: string, color: boolean): string => esc(1, text, color)
const dim = (text: string, color: boolean): string => esc(2, text, color)
const green = (text: string, color: boolean): string => esc(32, text, color)
const yellow = (text: string, color: boolean): string => esc(33, text, color)
const red = (text: string, color: boolean): string => esc(31, text, color)
const cyan = (text: string, color: boolean): string => esc(36, text, color)
const magenta = (text: string, color: boolean): string => esc(35, text, color)
const faint = (text: string, color: boolean): string => esc(90, text, color)

const BRAND = (color: boolean): string => `${magenta("🐎", color)} ${bold("WHIPPER", color)}  ${cyan("♞", color)}`

export function shouldUseColor(flags: Map<string, string | boolean>): boolean {
  return Boolean(process.stdout.isTTY && process.env["NO_COLOR"] === undefined && !flags.has("plain"))
}

export function renderHelp(options: UiOptions = {}): string {
  const color = options.color ?? false
  return [
    `${BRAND(color)}  ${dim("a steady hand for your agent team", color)}`,
    "",
    `Each agent works in a focused harness. ${bold("Whipper sets the route, pace, and limits.", color)}`,
    "Merging always stays human. 🤝",
    "",
    bold("👀 SEE THE TEAM", color),
    `  ${cyan("status", color)}                 🧭 Ready, blocked, waiting, and in-flight work`,
    `  ${cyan("harness", color)}                🛠️  Inspect each agent's role, model, and step limit`,
    `  ${cyan("hitch", color)}                  🪢 Verify the team is connected to this project`,
    `  ${cyan("cockpit", color)}               🎛️  Open the live project cockpit`,
    `  ${cyan("ledger", color)}                🧾 Cost and token usage by ticket, phase, run, or agent`,
    "",
    bold("🚀 MOVE THE TEAM", color),
    `  ${green("crack", color)}                  ⚡ Crack the whip: reconcile and dispatch the team`,
    `  ${green("hit", color)} ${dim("<KEY>", color)}              🎯 Target one durable ticket directly`,
    "",
    bold("FIRST RIDE", color),
    `  ${dim("$", color)} whipper status`,
    `  ${dim("$", color)} whipper crack --dry-run`,
    `  ${dim("$", color)} whipper hit LIN-123`,
    "",
    bold("COMMON OPTIONS", color),
    "  --config <path>         Use a specific .sdlc/config.json",
    "  --dry-run               Walk the route without outside-world mutations",
    "  --runtime <name>        Override the configured agent runtime",
    "  --json                  Machine-readable output (status)",
    "  --plain                 Disable color and terminal styling",
    "  --debug                 Include diagnostic detail",
    "  -h, --help              Show this guide",
    "  -v, --version           Show the version",
    "",
    dim("Compatibility: `sdlc` and `deliver` / `run` / `tick` / `serve` remain supported.", color),
  ].join("\n")
}

export function renderStatus(report: StatusReport, options: UiOptions = {}): string {
  const color = options.color ?? false
  const { budget } = report.config
  const lines = [
    `${BRAND(color)}  ${dim(`team ${report.workspace.team} · ${report.config.adapters}`, color)}`,
    rule(color),
    metric("🟢", report.ready.length, "ready at the gate"),
    metric("🐎", report.inFlight.length, `on the trail · cap ${budget.maxParallelDeliveries}`),
    metric("🚧", report.blocked.length, "held by dependencies"),
    metric("🙋", report.waitingForHuman.length, "waiting for you"),
    "",
  ]

  section(lines, "🟢 READY AT THE GATE", report.ready, color, (t) => `${green("●", color)} ${key(t.key, color)}  ${t.title}`)
  section(
    lines,
    "🐎 ON THE TRAIL",
    report.inFlight,
    color,
    (t) => `${yellow("◆", color)} ${key(t.key, color)}  ${t.title}`,
  )
  section(
    lines,
    "🚧 HELD BY DEPENDENCIES",
    report.blocked,
    color,
    (t) => `${red("■", color)} ${key(t.key, color)}  ${t.title}\n      ${dim(`⏳ waiting for ${t.blocker}`, color)}`,
  )
  section(
    lines,
    "🙋 WAITING FOR YOU",
    report.waitingForHuman,
    color,
    (t) => `${yellow("?", color)} ${key(t.key, color)}  ${t.title}`,
  )

  lines.push(bold("🧭 NEXT MOVE", color))
  if (report.wouldDeliverNow > 0) {
    lines.push(`  ${green("whipper crack ⚡", color)}  ${dim(`will dispatch ${report.wouldDeliverNow} ticket${report.wouldDeliverNow === 1 ? "" : "s"}`, color)}`)
  } else if (report.waitingForHuman.length > 0) {
    lines.push(`  ${yellow("Open the tracker", color)}  ${dim("an agent is waiting for human context 🙋", color)}`)
  } else {
    lines.push(`  ${dim("Nothing to dispatch right now. ☕", color)}`)
  }
  lines.push("")
  lines.push(
    dim(
      `🛡️  guardrails  $${budget.perTaskUsd}/task · ${formatTokens(budget.perTaskTokens)} tokens/task · ${report.config.phasesEnabled.length > 0 ? `${report.config.phasesEnabled.length} phases` : "default route"}${report.config.dryRun ? " · 🎬 DRY RUN" : ""}`,
      color,
    ),
  )
  lines[0] = stamp(lines[0] ?? "", options)
  return lines.join("\n")
}

export function renderRunStart(repoRoot: string, dryRun: boolean, options: UiOptions = {}): string {
  const color = options.color ?? false
  const head = `${BRAND(color)}  ${dryRun ? yellow("🎬 dry run", color) : green("🚀 team moving", color)}`
  return `${stamp(head, options)}\n${dim(repoRoot, options.color ?? false)}\n${rule(color)}`
}

export function renderRunSummary(
  candidates: { key: string; status: string; reason?: string }[],
  ledger: { key: string; costUsd: number; tokens: number; runs: number }[],
  options: UiOptions = {},
): string {
  const color = options.color ?? false
  const moved = candidates.filter((candidate) => candidate.status !== "skipped").length
  const skipped = candidates.length - moved
  const lines = ["", bold("🏁 RIDE COMPLETE", color), `${green("✅", color)} ${moved} moved   ${dim(`○ ${skipped} stayed put`, color)}`]
  for (const candidate of candidates) {
    const icon = candidate.status === "skipped" ? dim("○", color) : statusIcon(candidate.status, color)
    lines.push(`  ${icon} ${key(candidate.key, color)}  ${candidate.status}${candidate.reason ? dim(` · ${candidate.reason}`, color) : ""}`)
  }
  if (ledger.length > 0) {
    lines.push("", bold("💸 SPEND", color))
    for (const row of ledger) {
      const cost = row.costUsd > 0 ? `$${row.costUsd.toFixed(2)}` : dim("no metered cost", color)
      lines.push(`  ${key(row.key, color)}  ${cost} · ${formatTokens(row.tokens)} tokens · ${row.runs} calls`)
    }
    if (ledger.every((row) => row.costUsd === 0)) {
      lines.push(dim("  💳 these models report $0 to the server (subscription plan) — tokens are the real meter", color))
    }
  }
  lines[1] = stamp(lines[1] ?? "", options)
  return lines.join("\n")
}

export function renderDeliveryStart(keyName: string, title: string, dryRun: boolean, options: UiOptions = {}): string {
  const color = options.color ?? false
  const lines = [
    `${BRAND(color)}  ${dryRun ? yellow("🎬 practice harness", color) : green("🎯 ticket harnessed", color)}`,
    rule(color),
    `📦 ${key(keyName, color)}  ${title}`,
    dim("  📋 split → 🔍 research → ⚙️  execute ⇄ 🔍 review → 🚀 publish → 🌍 preview → 🧪 test", color),
  ]
  return stamp(lines.join("\n"), options)
}

export function renderDeliveryResult(
  ticket: string,
  status: RunStatus,
  options: UiOptions = {},
  dryRun = false,
): string {
  const color = options.color ?? false
  const friendly: Record<RunStatus, string> = {
    delivered: "arrived at the human gate 🚪",
    "dry-run": "practice route complete",
    parked: "parked safely ⏳",
    escalated: "waiting for human guidance 🙋",
    failed: "stopped safely 🛟",
  }
  const message = dryRun && status === "delivered" ? friendly["dry-run"] : friendly[status]
  const displayedStatus = dryRun && status === "delivered" ? "dry-run" : status
  return `\n${statusIcon(displayedStatus, color)} ${key(ticket, color)}  ${message}`
}

export interface HarnessRow {
  role: string
  modelClass?: string
  model?: string
  steps?: number
}

export function renderHarnesses(rows: HarnessRow[], options: UiOptions = {}): string {
  const color = options.color ?? false
  const lines = [
    `${bold("🛠️  HARNESSES", color)}  ${cyan("♞", color)}  ${dim(`${rows.length} restrained specialists`, color)}`,
    rule(color),
    `${dim("ROLE".padEnd(14), color)} ${dim("CLASS".padEnd(12), color)} ${dim("MODEL", color)}`,
  ]
  for (const row of rows) {
    const role = row.role.padEnd(14)
    const modelClass = (row.modelClass ?? "default").padEnd(12)
    const model = row.model ?? "runtime default"
    const steps = row.steps ? ` · ≤${row.steps} steps` : ""
    lines.push(`${bold(role, color)} ${yellow(modelClass, color)} ${model}${dim(steps, color)}`)
  }
  lines.push("", dim("A harness is role + model + tools + context limits. Agents never set their own bounds.", color))
  return lines.join("\n")
}

export interface HitchReport {
  project: string
  configPath: string
  team: string
  harnesses: number
  adapters: { tracker: string; codehost: string; preview: string; runtime: string }
}

export function renderHitch(report: HitchReport, options: UiOptions = {}): string {
  const color = options.color ?? false
  return [
    `${bold("🪢 HITCHED", color)}  ${green("🟢 project team connected", color)}`,
    rule(color),
    `${bold("project", color).padEnd(color ? 22 : 14)} ${report.project}`,
    `${bold("team", color).padEnd(color ? 22 : 14)} ${report.team}`,
    `${bold("harnesses", color).padEnd(color ? 22 : 14)} ${report.harnesses}`,
    `${bold("tracker", color).padEnd(color ? 22 : 14)} ${report.adapters.tracker}`,
    `${bold("code host", color).padEnd(color ? 22 : 14)} ${report.adapters.codehost}`,
    `${bold("preview", color).padEnd(color ? 22 : 14)} ${report.adapters.preview}`,
    `${bold("runtime", color).padEnd(color ? 22 : 14)} ${report.adapters.runtime}`,
    "",
    dim(report.configPath, color),
    "",
    `${green("next", color)}  whipper status`,
  ].join("\n")
}

export function renderLedger(
  by: string,
  rows: { key: string; runs: number; tokens: number; costUsd: number }[],
  options: UiOptions = {},
): string {
  const color = options.color ?? false
  if (rows.length === 0) {
    return `${bold("🧾 LEDGER", color)}\n${dim("No model usage recorded yet. 💤", color)}`
  }
  const lines = [
    `${bold("🧾 LEDGER", color)}  ${dim(`grouped by ${by}`, color)}`,
    rule(color),
    `${dim("NAME".padEnd(26), color)} ${dim("CALLS".padStart(7), color)} ${dim("TOKENS".padStart(10), color)} ${dim("COST".padStart(9), color)}`,
  ]
  for (const row of rows) {
    const name = row.key.slice(0, 24).padEnd(26)
    lines.push(
      `${bold(name, color)} ${String(row.runs).padStart(7)} ${formatTokens(row.tokens).padStart(10)} ${`$${row.costUsd.toFixed(2)}`.padStart(9)}`,
    )
  }
  const total = rows.reduce(
    (sum, row) => ({ calls: sum.calls + row.runs, tokens: sum.tokens + row.tokens, cost: sum.cost + row.costUsd }),
    { calls: 0, tokens: 0, cost: 0 },
  )
  lines.push(rule(color))
  lines.push(
    `${bold("TOTAL".padEnd(26), color)} ${String(total.calls).padStart(7)} ${formatTokens(total.tokens).padStart(10)} ${`$${total.cost.toFixed(2)}`.padStart(9)}`,
  )
  if (total.cost === 0 && total.tokens > 0) {
    lines.push(dim("💳 these models report no metered cost (subscription plan) — treat tokens as the spend", color))
  }
  lines[0] = stamp(lines[0] ?? "", options)
  return lines.join("\n")
}

export function renderError(message: string, options: UiOptions = {}): string {
  const color = options.color ?? false
  return `${red("🛑 STOPPED SAFELY", color)}\n${message}\n${dim("No merge was performed. Re-run with --debug for detail.", color)}`
}

function rule(color: boolean): string {
  return dim("────────────────────────────────────────────────", color)
}

function metric(icon: string, value: number, label: string): string {
  return `${icon} ${String(value).padStart(2)}  ${label}`
}

function key(value: string, color: boolean): string {
  return bold(value.padEnd(9), color)
}

function section<T>(
  lines: string[],
  heading: string,
  rows: T[],
  color: boolean,
  format: (row: T) => string,
): void {
  if (rows.length === 0) return
  lines.push(bold(heading, color))
  for (const row of rows) lines.push(`  ${format(row)}`)
  lines.push("")
}

function statusIcon(status: string, color: boolean): string {
  void color
  if (status === "delivered") return "✅"
  if (status === "dry-run") return "🎬"
  if (status === "parked") return "⏸️"
  if (status === "escalated") return "🙋"
  return "❌"
}
