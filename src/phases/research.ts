import { formatTicket, renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, researchResultSchema, type ResearchResult } from "./base.js"

/**
 * Researcher/designer: reads the code (it has read access to the worktree) and
 * produces the execution plan + a confidence signal. Low confidence routes to
 * the council phase — the runner decides that, never the researcher.
 */
export const researchPhase = definePhase<ResearchResult>({
  name: "research",
  usesLLM: true,
  role: "researcher",
  input: async (task) => ({
    text: renderPrompt("research", {
      ticket: truncate(formatTicket(task.ticket)),
      worktree: task.worktree ?? "",
    }),
  }),
  parse: async (output) => validateVerdict("research", output, researchResultSchema),
  onResult: async (task, result) => {
    task.artifacts.set("plan.md", result.planMarkdown)
    task.artifacts.setJSON("research.json", { confidence: result.confidence, questions: result.questions })
  },
})
