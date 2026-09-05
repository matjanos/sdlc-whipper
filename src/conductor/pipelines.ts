import type { Phase, ReviewResult } from "../phases/base.js"
import { loadPhases } from "../phases/registry.js"
import type { PhaseName } from "../types.js"
import type { ConductorDeps, Outcomes, TaskContext } from "./deps.js"
import { escalate } from "./actions.js"
import { BudgetExceededError, EscalationError, type RunStatus } from "../types.js"
import { VerdictParseError } from "../phases/shared.js"

/**
 * Pipelines are data. Reorder, disable, or insert steps here without touching
 * the runner or phases. `when` gates on prior outcomes; `loopWith` re-runs the
 * partner phase (executor) when this phase (reviewer) does not approve —
 * bounded by maxRounds in code, never by an LLM's judgement.
 */
export interface StepDef {
  phase: PhaseName
  when?: (o: Outcomes) => boolean
  loopWith?: PhaseName
  maxRounds?: number
  exit?: (o: Outcomes) => boolean
}

export const DELIVERY_PIPELINE: StepDef[] = [
  { phase: "split" },
  { phase: "research" },
  { phase: "council", when: (o) => readAs<{ confidence?: string }>(o, "research")?.confidence === "low" },
  { phase: "execute" },
  { phase: "review", loopWith: "execute", exit: (o) => readAs<ReviewResult>(o, "review")?.verdict === "approve" },
  { phase: "publish" },
  { phase: "await-preview" },
  { phase: "test", when: (o) => readAs<{ skipped?: boolean }>(o, "await-preview")?.skipped !== true },
]

function readAs<T>(o: Outcomes, key: string): T | undefined {
  return o[key] as T | undefined
}

function phaseEnabled(deps: ConductorDeps, name: PhaseName): boolean {
  const flag = deps.config.raw.phases[name]
  return flag?.enabled !== false
}

/** Run one LLM phase end-to-end: assemble context (firewall) → budget → prompt → parse → side effects. */
async function runLLMPhase(
  deps: ConductorDeps,
  task: TaskContext,
  phase: Phase<unknown>,
  outcomes: Outcomes,
  opts: { fresh?: boolean } = {},
): Promise<void> {
  if (!phase.role || !phase.input) throw new Error(`${phase.name}: not an LLM phase`)
  const parts = await phase.input(task, outcomes)
  await deps.budget.assert(task.runId)
  const output = await deps.runtime.prompt(phase.role, parts, { fresh: opts.fresh })
  const result = phase.parse ? await phase.parse(output, task) : output
  outcomes[phase.name] = result
  deps.log.info(`${phase.name}: ok${opts.fresh ? " (fresh)" : ""}`)
  if (phase.onResult) await phase.onResult(task, result, outcomes)
}

async function runPurePhase(
  deps: ConductorDeps,
  task: TaskContext,
  phase: Phase<unknown>,
  outcomes: Outcomes,
): Promise<void> {
  if (!phase.run) throw new Error(`${phase.name}: not a pure phase`)
  const result = await phase.run(task, outcomes)
  outcomes[phase.name] = result
  deps.log.info(`${phase.name}: ok`)
  if (phase.onResult) await phase.onResult(task, result, outcomes)
}

/** Run the delivery pipeline for one task. Never throws — returns a RunStatus. */
export async function runDeliveryPipeline(
  deps: ConductorDeps,
  task: TaskContext,
): Promise<{ status: RunStatus; outcomes: Outcomes; phaseReached: PhaseName | "tick" }> {
  const phases = await loadPhases()
  const outcomes: Outcomes = {}
  let phaseReached: PhaseName | "tick" = "tick"

  for (const step of DELIVERY_PIPELINE) {
    if (!phaseEnabled(deps, step.phase)) {
      deps.log.info(`${step.phase}: disabled in config — skipping`)
      continue
    }
    const phase = phases.get(step.phase)
    if (!phase) throw new Error(`pipeline references unknown phase "${step.phase}"`)
    if (step.when && !step.when(outcomes)) {
      deps.log.info(`${step.phase}: condition not met — skipping`)
      continue
    }
    phaseReached = step.phase

    try {
      if (step.loopWith) {
        const partner = phases.get(step.loopWith)
        if (!partner) throw new Error(`pipeline loop references unknown phase "${step.loopWith}"`)
        const maxRounds = step.maxRounds ?? deps.config.raw.budget.maxLoopRounds
        let round = 0
        for (;;) {
          // reviewer always fresh — no session state may leak between rounds
          await runLLMPhase(deps, task, phase, outcomes, { fresh: round > 0 })
          const exitNow = step.exit ? step.exit(outcomes) : true
          if (exitNow) break
          round += 1
          if (round >= maxRounds) {
            const review = readAs<ReviewResult>(outcomes, "review")
            const findings = (review?.findings ?? [])
              .map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.issue}`)
              .join("\n")
            const execution = String(outcomes["execute"] ?? "(no execution summary)")
            throw new EscalationError(
              "stalemate",
              `No convergence after ${maxRounds} review rounds.\n\n**Last review findings:**\n${findings}\n\n**Last executor summary:**\n${execution}`,
            )
          }
          deps.log.warn(`review round ${round}/${maxRounds}: changes requested — going back to executor`)
          // re-run the partner (executor) in its existing session with findings
          await runLLMPhase(deps, task, partner, outcomes)
        }
      } else if (phase.usesLLM) {
        await runLLMPhase(deps, task, phase, outcomes)
      } else {
        await runPurePhase(deps, task, phase, outcomes)
      }
    } catch (err) {
      return { status: await handlePhaseError(deps, task, err, step.phase), outcomes, phaseReached }
    }
  }
  return { status: "delivered", outcomes, phaseReached }
}

async function handlePhaseError(
  deps: ConductorDeps,
  task: TaskContext,
  err: unknown,
  phase: PhaseName,
): Promise<RunStatus> {
  if (err instanceof EscalationError) {
    await escalate(deps, task.ticket.key, err.tag, err.body)
    deps.log.warn(`${phase}: escalated [${err.tag}]`)
    return err.tag === "needs-info" ? "escalated" : "parked"
  }
  if (err instanceof BudgetExceededError) {
    await deps.runtime.interruptAll()
    await escalate(deps, task.ticket.key, "budget-exceeded", err.message)
    deps.log.warn(`${phase}: budget exceeded — parked`)
    return "parked"
  }
  const detail =
    err instanceof VerdictParseError
      ? err.message
      : `${(err as Error).message ?? String(err)}\n${((err as Error).stack ?? "").split("\n").slice(0, 5).join("\n")}`
  await escalate(deps, task.ticket.key, "phase-error", `Phase **${phase}** failed:\n\n\`\`\`\n${detail}\n\`\`\``)
  deps.log.error(`${phase}: failed — ${(err as Error).message}`)
  return "failed"
}

/** Run a batch (non-pipeline) phase — grooming — against pre-fetched context. */
export async function runBatchPhase(
  deps: ConductorDeps,
  phase: Phase<unknown>,
  task: TaskContext,
  outcomes: Outcomes,
): Promise<{ ok: boolean; outcomes: Outcomes }> {
  try {
    await runLLMPhase(deps, task, phase, outcomes)
    return { ok: true, outcomes }
  } catch (err) {
    // no single ticket to comment on — log loudly; per-ticket questions were
    // already posted by the groomer's own onResult
    deps.log.error(
      `grooming failed: ${(err as Error).message} — no tickets were mutated by this run`,
    )
    return { ok: false, outcomes }
  }
}
