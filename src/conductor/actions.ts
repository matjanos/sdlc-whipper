import { selectorFor } from "../config.js"
import type { ConductorDeps } from "./deps.js"
import type { EscalationTag, LogicalState, Ticket, TicketDraft, PullRequest } from "../types.js"
import { EscalationError } from "../types.js"

export { EscalationError }
export type { ConductorDeps }

/**
 * Dry-run-aware side effects. Every mutation of the outside world goes through
 * here so `--dry-run` is honest: log the intent, touch nothing.
 */
export async function moveTo(deps: ConductorDeps, key: string, state: LogicalState): Promise<void> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would move ${key} → ${state}`)
    return
  }
  await deps.tracker.moveTo(key, state)
}

export async function addLabel(deps: ConductorDeps, key: string, logicalLabel: string): Promise<void> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would label ${key} + ${logicalLabel}`)
    return
  }
  const name = selectorFor(deps.config, logicalLabel).name
  await deps.tracker.addLabel(key, name)
}

export async function setRelation(
  deps: ConductorDeps,
  key: string,
  kind: "blocks" | "blocked-by" | "relates",
  otherKey: string,
): Promise<void> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would relate ${key} ${kind} ${otherKey}`)
    return
  }
  await deps.tracker.setRelation(key, kind, otherKey)
}

export async function createSubIssue(
  deps: ConductorDeps,
  parentKey: string,
  draft: TicketDraft,
): Promise<Ticket | undefined> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would create sub-issue under ${parentKey}: ${draft.title}`)
    return undefined
  }
  return deps.tracker.createSubIssue(parentKey, draft)
}

export async function openPR(
  deps: ConductorDeps,
  input: { title: string; body: string; head: string; base: string },
): Promise<PullRequest | undefined> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would open PR "${input.title}" (${input.head} → ${input.base})`)
    return undefined
  }
  return deps.codehost.openPR(input)
}

export async function approvePR(deps: ConductorDeps, pr: number, body: string): Promise<void> {
  if (deps.dryRun) {
    deps.log.info(`[dry-run] would approve PR #${pr}`)
    return
  }
  await deps.codehost.review(pr, "approve", body)
}

/**
 * Escalate to humans on the ticket. One comment per tag: the marker makes the
 * tracker adapter edit the existing comment instead of spamming a new one.
 */
export async function escalate(
  deps: ConductorDeps,
  ticketKey: string,
  tag: EscalationTag,
  body: string,
): Promise<void> {
  const marker = `<!-- sdlc:${tag} -->`
  const heading =
    tag === "needs-info"
      ? "I need a human decision before continuing. Please answer/attach:"
      : tag === "stalemate"
        ? "Executor and reviewer could not converge within the round limit. Both sides below — a human should arbitrate:"
        : tag === "budget-exceeded"
          ? "Stopped: the per-task budget was exceeded."
          : tag === "test-failed"
            ? "Stopped: the tester rejected the change on the preview environment."
            : "Stopped: an unexpected error occurred in the pipeline."
  const full = `${marker}\n## ${heading}\n\n${body}\n\n_(sdlc conductor, tag: ${tag})_`
  if (deps.dryRun) {
    deps.log.warn(`[dry-run] would escalate on ${ticketKey} [${tag}]:\n${body}`)
    return
  }
  await deps.tracker.comment(ticketKey, full, { editExistingTag: marker })
  if (tag === "needs-info") {
    try {
      await deps.tracker.addLabel(ticketKey, selectorFor(deps.config, "needsInfo").name)
    } catch (err) {
      deps.log.warn(`could not add needs-info label on ${ticketKey}: ${(err as Error).message}`)
    }
  }
}
