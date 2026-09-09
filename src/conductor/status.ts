import type { ConductorDeps } from "./deps.js"
import { needsInfoLabelName, selectedLabelName } from "./tick.js"
import { projectScope } from "../config.js"
import type { Ticket } from "../types.js"

export interface StatusReport {
  workspace: { team: string }
  ready: { key: string; title: string }[]
  blocked: { key: string; title: string; blocker: string }[]
  waitingForHuman: { key: string; title: string }[]
  inFlight: { key: string; title: string }[]
  config: {
    adapters: string
    phasesEnabled: string[]
    budget: { maxParallelDeliveries: number; perTaskUsd: number; perTaskTokens: number }
    dryRun: boolean
  }
  wouldDeliverNow: number
}

/** Read-only reconciliation: what a tick would do and why. M1 deliverable. */
export async function buildStatus(deps: ConductorDeps): Promise<StatusReport> {
  const ws = await deps.tracker.discoverWorkspace()
  const selected = await deps.tracker.listIssues({ ...projectScope(deps.config), logicalLabel: "selected" })
  const needsInfo = needsInfoLabelName(deps)
  const ready: StatusReport["ready"] = []
  const blocked: StatusReport["blocked"] = []
  const waiting: StatusReport["waitingForHuman"] = []

  for (const brief of selected) {
    let ticket: Ticket
    try {
      ticket = await deps.tracker.getTicket(brief.key)
    } catch {
      waiting.push({ key: brief.key, title: `${brief.title} (fetch failed)` })
      continue
    }
    if (ticket.labels.includes(needsInfo)) {
      waiting.push({ key: ticket.key, title: ticket.title })
      continue
    }
    const blocker = ticket.relations.find(
      (r) => r.kind === "blocked-by" && r.state !== "done" && r.state !== "cancelled",
    )
    if (blocker) {
      blocked.push({ key: ticket.key, title: ticket.title, blocker: `${blocker.key} (${blocker.state})` })
    } else if (ticket.state === "backlog" || ticket.state === "selected") {
      ready.push({ key: ticket.key, title: ticket.title })
    }
  }

  const inFlightBrief = await deps.tracker.listIssues({ ...projectScope(deps.config), state: "inProgress" })
  const phasesEnabled = Object.entries(deps.config.raw.phases)
    .filter(([, v]) => v.enabled !== false)
    .map(([k]) => k)

  const slots = Math.max(0, deps.config.raw.budget.maxParallelDeliveries - inFlightBrief.length)
  return {
    workspace: { team: ws.teamKey },
    ready,
    blocked,
    waitingForHuman: waiting,
    inFlight: inFlightBrief.map((t) => ({ key: t.key, title: t.title })),
    config: {
      adapters: `${deps.config.raw.adapters.tracker}/${deps.config.raw.adapters.codehost}/${deps.config.raw.adapters.preview}/${deps.config.raw.adapters.runtime}`,
      phasesEnabled,
      budget: {
        maxParallelDeliveries: deps.config.raw.budget.maxParallelDeliveries,
        perTaskUsd: deps.config.raw.budget.perTaskUsd,
        perTaskTokens: deps.config.raw.budget.perTaskTokens,
      },
      dryRun: deps.dryRun,
    },
    wouldDeliverNow: Math.min(slots, ready.length),
  }
}

/** Plain formatter retained for programmatic callers. The CLI's richer skin lives in cli/ui.ts. */
export function formatStatus(r: StatusReport): string {
  const lines = [
    `WHIPPER  team ${r.workspace.team} · ${r.config.adapters}`,
    "────────────────────────────────────────────────",
    `● ${String(r.ready.length).padStart(2)}  ready at the gate`,
    `◆ ${String(r.inFlight.length).padStart(2)}  on the trail · cap ${r.config.budget.maxParallelDeliveries}`,
    `■ ${String(r.blocked.length).padStart(2)}  held by dependencies`,
    `? ${String(r.waitingForHuman.length).padStart(2)}  waiting for you`,
  ]
  if (r.ready.length > 0) {
    lines.push("", "READY AT THE GATE")
    for (const t of r.ready) lines.push(`  ● ${t.key.padEnd(9)} ${t.title}`)
  }
  if (r.blocked.length > 0) {
    lines.push("", "HELD BY DEPENDENCIES")
    for (const t of r.blocked) lines.push(`  ■ ${t.key.padEnd(9)} ${t.title}\n      waiting for ${t.blocker}`)
  }
  lines.push("", "NEXT MOVE")
  lines.push(r.wouldDeliverNow > 0 ? `  whipper crack  will dispatch ${r.wouldDeliverNow}` : "  Nothing to dispatch right now.")
  return lines.join("\n")
}
