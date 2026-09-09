import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { loadPhases } from "../phases/registry.js"
import { projectScope, selectorFor } from "../config.js"
import { moveTo, escalate } from "./actions.js"
import type { ConductorDeps } from "./deps.js"
import { Artifacts } from "./artifacts.js"
import { runBatchPhase, runDeliveryPipeline } from "./pipelines.js"
import { ensureWorktree } from "../git/worktrees.js"
import type { RunState, RunStatus, Ticket } from "../types.js"
import { withTickLock } from "../util/lock.js"

export interface TickCandidateResult {
  key: string
  title: string
  status: RunStatus | "skipped"
  reason?: string
}

export interface TickReport {
  ts: string
  dryRun: boolean
  groom: { ran: boolean; ok?: boolean; note?: string }
  candidates: TickCandidateResult[]
}

interface TickState {
  lastGroomAt?: string
}

function statePath(deps: ConductorDeps): string {
  return path.join(deps.config.whipperDir, "state.json")
}

function readTickState(deps: ConductorDeps): TickState {
  try {
    return JSON.parse(readFileSync(statePath(deps), "utf8")) as TickState
  } catch {
    return {}
  }
}

function writeTickState(deps: ConductorDeps, state: TickState): void {
  if (deps.dryRun) {
    deps.log.info("[dry-run] would update tick state")
    return
  }
  writeFileSync(statePath(deps), JSON.stringify(state, null, 2))
}

export function needsInfoLabelName(deps: ConductorDeps): string {
  return selectorFor(deps.config, "needsInfo").name
}

export function selectedLabelName(deps: ConductorDeps): string {
  return selectorFor(deps.config, "selected").name
}

export function classifyCandidate(deps: ConductorDeps, ticket: Ticket): string | undefined {
  const needsInfo = needsInfoLabelName(deps)
  if (ticket.labels.includes(needsInfo)) return "waiting for human answers (needs-info)"
  const blocker = ticket.relations.find(
    (r) => r.kind === "blocked-by" && r.state !== "done" && r.state !== "cancelled",
  )
  if (blocker) return `blocked by ${blocker.key} (${blocker.state})`
  if (ticket.state === "inProgress") return "already in progress"
  if (ticket.state === "inReview") return "already in review"
  if (ticket.state === "done" || ticket.state === "cancelled") return "not actionable"
  return undefined
}

/** One tick: reconcile → (maybe) groom → dispatch deliveries → record. Crash-safe by construction. */
export async function runTick(deps: ConductorDeps): Promise<TickReport> {
  return withTickLock(deps.config.whipperDir, 30 * 60_000, async () => {
    const report: TickReport = { ts: new Date().toISOString(), dryRun: deps.dryRun, groom: { ran: false }, candidates: [] }

    // Validate the tracker mapping early — a misconfigured workspace fails fast, loudly.
    await deps.tracker.discoverWorkspace()

    // 1. Grooming (own cadence, phase-flagged)
    const groomCfg = deps.config.raw.phases["groom"]
    const cadenceMs = (groomCfg?.cadenceMinutes ?? 60) * 60_000
    const last = readTickState(deps).lastGroomAt ? Date.parse(readTickState(deps).lastGroomAt!) : 0
    if (groomCfg?.enabled !== false && Date.now() - last >= cadenceMs) {
      report.groom = { ran: true }
      try {
        const backlog = await deps.tracker.listIssues({ ...projectScope(deps.config), state: "backlog" })
        if (backlog.length === 0) {
          report.groom.note = "backlog empty — nothing to groom"
        } else {
          const phases = await loadPhases()
          const groom = phases.get("groom")!
          const artifacts = new Artifacts(path.join(deps.config.artifactsDir, "_groom"))
          const task = {
            ticket: GROOM_TICKET,
            worktree: undefined,
            artifacts,
            deps,
            runId: `groom_${Date.now()}`,
          }
          const { ok } = await runBatchPhase(deps, groom, task, { backlog })
          report.groom.ok = ok
          writeTickState(deps, { ...readTickState(deps), lastGroomAt: new Date().toISOString() })
        }
      } catch (err) {
        report.groom.ok = false
        report.groom.note = (err as Error).message
      }
    }

    // 2. Delivery candidates
    const selected = await deps.tracker.listIssues({ ...projectScope(deps.config), logicalLabel: "selected" })
    const results: TickCandidateResult[] = []
    const ready: Ticket[] = []
    for (const brief of selected) {
      let ticket: Ticket
      try {
        ticket = await deps.tracker.getTicket(brief.key)
      } catch (err) {
        results.push({ key: brief.key, title: brief.title, status: "skipped", reason: `fetch failed: ${(err as Error).message}` })
        continue
      }
      const reason = classifyCandidate(deps, ticket)
      if (reason) {
        results.push({ key: ticket.key, title: ticket.title, status: "skipped", reason })
      } else {
        ready.push(ticket)
      }
    }

    // 3. Concurrency cap
    const inFlight = (await deps.tracker.listIssues({ ...projectScope(deps.config), state: "inProgress" })).length
    const slots = Math.max(0, deps.config.raw.budget.maxParallelDeliveries - inFlight)
    const toDeliver = ready.slice(0, slots)
    const overflow = ready.slice(slots)
    for (const t of overflow) {
      results.push({ key: t.key, title: t.title, status: "skipped", reason: "concurrency cap reached" })
    }

    for (const ticket of toDeliver) {
      const status = await deliverTask(deps, ticket)
      results.push({ key: ticket.key, title: ticket.title, status })
    }

    report.candidates = results
    return report
  })
}

/** Synthetic ticket for batch (grooming) contexts. */
const GROOM_TICKET: Ticket = {
  key: "GROOM",
  title: "Backlog grooming sweep",
  description: "",
  comments: [],
  labels: [],
  state: "backlog",
  relations: [],
}

/** Deliver one ticket end-to-end. Never throws. */
export async function deliverTask(deps: ConductorDeps, ticket: Ticket): Promise<RunStatus> {
  const runId = `run_${ticket.key}_${new Date().toISOString().replace(/[:.]/g, "-")}`
  const log = deps.log.child(ticket.key)
  const artifacts = new Artifacts(path.join(deps.config.artifactsDir, ticket.key))
  let worktree: string | undefined
  try {
    worktree = await ensureWorktree(deps.config, ticket.key)
  } catch (err) {
    log.error(`worktree setup failed: ${(err as Error).message}`)
    return "failed"
  }
  const task = { ticket, worktree, artifacts, deps, runId }
  await moveTo(deps, ticket.key, "inProgress")

  try {
    await deps.runtime.open({ runId, ticket: ticket.key, worktree })
  } catch (err) {
    // Runtime setup failures (bad model config, unreachable server) must land
    // on the ticket, not kill the whole tick — later candidates still deliver.
    log.error(`runtime setup failed: ${(err as Error).message}`)
    await escalate(deps, ticket.key, "phase-error", `Runtime setup failed:\n\n\`\`\`\n${(err as Error).message}\n\`\`\``)
    return "failed"
  }
  let status: RunStatus
  let phaseReached: string
  let outcomes: Record<string, unknown>
  try {
    const result = await runDeliveryPipeline(deps, task)
    status = result.status
    phaseReached = result.phaseReached
    outcomes = result.outcomes
  } finally {
    await deps.runtime.close()
  }

  if (status === "delivered") {
    const publish = outcomes["publish"] as { skipped?: boolean } | undefined
    await moveTo(deps, ticket.key, "inReview")
    log.info(`${deps.dryRun ? "practice route complete" : "delivered"}${publish?.skipped ? " (stub run — no PR opened)" : ""}`)
  } else {
    // escalated / parked / failed: stay In Progress; the escalation comment on
    // the ticket tells the human why. They decide the next move.
    log.warn(`run ended: ${status} at ${phaseReached}`)
  }

  const runState: RunState = {
    runId,
    ticket: ticket.key,
    status: deps.dryRun ? "dry-run" : status,
    startedAt: runId,
    updatedAt: new Date().toISOString(),
    phaseReached: phaseReached as RunState["phaseReached"],
    message: status === "delivered" && (outcomes["publish"] as { skipped?: boolean } | undefined)?.skipped
      ? "stub run — publish skipped (no commits)"
      : undefined,
  }
  if (!deps.dryRun) artifacts.setJSON("state.json", runState)
  return status
}
