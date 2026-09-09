import type { Phase, ReviewResult } from "../phases/base.js"
import { loadPhases } from "../phases/registry.js"
import type { PhaseName } from "../types.js"
import type { ConductorDeps, Outcomes, TaskContext } from "./deps.js"
import { escalate } from "./actions.js"
import { withTransientRetry } from "./retry.js"
import { BudgetExceededError, EscalationError, ModelCallFailedError, type RunStatus } from "../types.js"
import { VerdictParseError } from "../phases/shared.js"
import { resolveModel } from "../config.js"
import { createSpinner, formatElapsed, renderTrail } from "../util/progress.js"
import { formatTokens } from "../util/format.js"
import { isShuttingDown } from "../util/shutdown.js"

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

/**
 * Mechanical format correction for an unparsable verdict. Carries no new
 * context (firewall-safe): it only restates the output contract. Bounded —
 * runLLMPhase re-asks exactly once before failing the phase.
 */
const VERDICT_CORRECTION =
  "Your previous reply could not be parsed: the final ```json verdict block was missing or invalid. " +
  "Reply again with your verdict and END your reply with the exact ```json verdict block specified in the task, nothing after it."

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

  const spinner = createSpinner()
  const startedAt = Date.now()
  const role = phase.role
  const model = resolveModel(deps.config, role)?.split("/").pop()
  const label = `${role.startsWith(phase.name) ? phase.name : `${phase.name} · ${role}`}${model ? ` · ${model}` : ""}`
  task.events?.append({ level: "info", phase: phase.name, role, text: "phase started" })
  spinner.start(`${label} — working`)
  deps.runtime.activityFeed?.((info) => {
    if (info.role !== role) return
    const tokens = info.tokens ? ` · ${formatTokens(info.tokens)} tok` : ""
    spinner.update(`${label} — ${info.text}${tokens}`)
    task.events?.append({ level: "debug", phase: phase.name, role, text: info.text, tokens: info.tokens })
  })

  const prompt = (text: Parameters<typeof deps.runtime.prompt>[1]) =>
    withTransientRetry(() => deps.runtime.prompt(phase.role!, text, { fresh: opts.fresh }), {
      retries: 2,
      baseDelayMs: 10_000,
      log: deps.log,
      label: `${phase.name}/${phase.role}`,
    })
  try {
    let output = await prompt(parts)
    const parse = () => (phase.parse ? phase.parse(output, task) : output)
    let retried = false
    let result
    try {
      result = await parse()
    } catch (err) {
      // An unparsable verdict is flow control, not a phase failure: re-ask the
      // same session once with a mechanical correction (bounded in code). The
      // correction carries no new context — firewall stays intact.
      if (!(err instanceof VerdictParseError)) throw err
      deps.log.warn(`${phase.name}: verdict unparsable — one corrective re-ask`)
      task.events?.append({ level: "warn", phase: phase.name, role, text: "verdict unparsable — corrective re-ask" })
      await deps.budget.assert(task.runId)
      output = await prompt({ text: VERDICT_CORRECTION })
      retried = true
      result = await parse()
    }
    outcomes[phase.name] = result
    spinner.stop() // free the line before the phase log lands on it
    deps.log.info(
      `${phase.name}: ok${opts.fresh ? " (fresh)" : ""}${retried ? " (verdict retried)" : ""} (${formatElapsed(Date.now() - startedAt)})`,
    )
    task.events?.append({
      level: "info",
      phase: phase.name,
      role,
      text: `phase completed${retried ? " (verdict retried)" : ""} in ${formatElapsed(Date.now() - startedAt)}`,
    })
    if (phase.onResult) await phase.onResult(task, result, outcomes)
  } finally {
    spinner.stop()
  }
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
  task.events?.append({ level: "info", phase: phase.name, text: "phase completed" })
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
      task.events?.append({ level: "info", phase: step.phase, text: "disabled — skipped" })
      continue
    }
    const phase = phases.get(step.phase)
    if (!phase) throw new Error(`pipeline references unknown phase "${step.phase}"`)
    if (step.when && !step.when(outcomes)) {
      deps.log.info(`${step.phase}: condition not met — skipping`)
      task.events?.append({ level: "info", phase: step.phase, text: "condition not met — skipped" })
      continue
    }
    phaseReached = step.phase
    // quiet wayfinding: the route so far, where we are, what is ahead
    const route = DELIVERY_PIPELINE.filter((s) => phaseEnabled(deps, s.phase))
      .filter((s) => !s.when || s.when(outcomes))
      .map((s) => s.phase)
    const at = route.indexOf(step.phase)
    if (at >= 0) {
      deps.log.info(
        renderTrail(route.map((name, i) => ({ name, state: i < at ? "done" : i === at ? "current" : "todo" }))),
      )
    }

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
          task.events?.append({
            level: "warn",
            phase: step.phase,
            text: `review round ${round}/${maxRounds}: changes requested — returning to executor`,
          })
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
  if (isShuttingDown()) {
    // user-initiated stop: sessions were interrupted, lock released — do not
    // post escalations or retry against a world the user asked to stop.
    deps.log.warn(`${phase}: interrupted by user — stopping without escalation`)
    task.events?.append({ level: "warn", phase, text: "interrupted by user" })
    return "failed"
  }
  if (err instanceof EscalationError) {
    await escalate(deps, task.ticket.key, err.tag, err.body)
    deps.log.warn(`${phase}: escalated [${err.tag}]`)
    task.events?.append({ level: "warn", phase, text: `escalated: ${err.tag}` })
    return err.tag === "needs-info" ? "escalated" : "parked"
  }
  if (err instanceof BudgetExceededError) {
    await deps.runtime.interruptAll()
    await escalate(deps, task.ticket.key, "budget-exceeded", err.message)
    deps.log.warn(`${phase}: budget exceeded — parked`)
    task.events?.append({ level: "warn", phase, text: `budget exceeded — parked: ${err.message}` })
    return "parked"
  }
  if (err instanceof ModelCallFailedError && /rate.?limit|usage limit|429/i.test(err.message)) {
    // Provider quota windows reset on their own schedule — retrying here would
    // burn the polling loop against a wall. Park the ticket; a later tick or
    // `sdlc deliver` resumes it.
    await escalate(
      deps,
      task.ticket.key,
      "provider-rate-limit",
      `${err.message}\n\nThe conductor does not retry automatically. Wait for the provider window to reset, then run another tick (or \`sdlc deliver ${task.ticket.key}\`).`,
    )
    deps.log.warn(`${phase}: provider rate limit — parked`)
    task.events?.append({ level: "warn", phase, text: "provider rate limit — parked" })
    return "parked"
  }
  const detail =
    err instanceof VerdictParseError
      ? err.message
      : describeError(err)
  await escalate(deps, task.ticket.key, "phase-error", `Phase **${phase}** failed:\n\n\`\`\`\n${detail}\n\`\`\``)
  deps.log.error(`${phase}: failed — ${describeError(err)}`)
  task.events?.append({ level: "error", phase, text: `phase failed: ${detail}` })
  return "failed"
}

/** Full error chain, not just the top message — transport errors are often opaque wrappers. */
function describeError(err: unknown, depth = 0): string {
  const e = err as { name?: string; message?: string; cause?: unknown }
  const line = `${e.name ?? "Error"}: ${e.message ?? String(err)}`
  if (depth >= 4 || !e.cause) return line
  return `${line}\n  caused by ${describeError(e.cause, depth + 1)}`
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
