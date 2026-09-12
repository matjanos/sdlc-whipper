import { renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, groomResultSchema, type GroomResult } from "./base.js"
import { addLabel, createSubIssue, escalate, setRelation } from "../conductor/actions.js"
import { selectorFor } from "../config.js"

/**
 * Groomer: batch phase, run from the tick loop on its own cadence (not part of
 * the delivery pipeline). Checks the backlog against the Definition of Ready,
 * asks questions for unclear tickets (phrased for non-technical owners), marks
 * delivery candidates (`selected` label), records the dependency graph via
 * ticket relations, and splits oversized work into sub-issues.
 *
 * Batches are release-coherent (a Linear project / tracker project), not
 * size-based — size is explicitly not a grouping criterion.
 */
export const groomPhase = definePhase<GroomResult>({
  name: "groom",
  usesLLM: true,
  role: "groomer",
  input: async (_task, outcomes) => {
    const backlog = outcomes["backlog"] as import("../types.js").Ticket[] | undefined
    if (!backlog?.length) throw new Error("groom: empty backlog snapshot")
    const selectedName = selectorFor(_task.deps.config, "selected").name
    const listing = backlog
      .map((t) => {
        const lines = [
          `- ${t.key} [${t.state}${t.labels.includes(selectedName) ? "|selected" : ""}]: ${t.title}`,
          `  ${truncate(t.description || "(no description)", 600)}`,
        ]
        if (t.relations.length) {
          lines.push(`  relations: ${t.relations.map((r) => `${r.kind} ${r.key} (${r.state})`).join(", ")}`)
        }
        if (t.comments.length) {
          lines.push("  comments (latest last — earlier needs-info answers live here):")
          for (const c of t.comments.slice(-3)) {
            lines.push(`  - ${c.author} (${c.createdAt}): ${truncate(c.body, 300)}`)
          }
        }
        return lines.join("\n")
      })
      .join("\n")
    return { text: renderPrompt("groom", { backlog: listing, count: String(backlog.length) }) }
  },
  parse: async (output) => validateVerdict("groom", output, groomResultSchema),
  onResult: async (task, result) => {
    task.artifacts.setJSON("groom.json", result)
    for (const key of result.selected) await addLabel(task.deps, key, "selected")
    for (const rel of result.relations) await setRelation(task.deps, rel.from, rel.kind, rel.to)
    for (const split of result.splits) {
      for (const draft of split.drafts) await createSubIssue(task.deps, split.parentKey, draft)
    }
    for (const q of result.questions) {
      await escalate(task.deps, q.key, "needs-info", q.body)
    }
  },
})
