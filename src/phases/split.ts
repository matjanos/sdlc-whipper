import { formatTicket, renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, splitResultSchema, type SplitResult } from "./base.js"
import { EscalationError } from "../types.js"

/**
 * Split / orchestrator: turn the ticket into a deterministic acceptance check
 * (a failing test) before anything is built. TDD for agent work — this test is
 * the objective definition of done both the executor and CI must satisfy.
 */
export const splitPhase = definePhase<SplitResult>({
  name: "split",
  usesLLM: true,
  role: "split",
  input: async (task) => ({
    text: renderPrompt("split", { ticket: truncate(formatTicket(task.ticket)) }),
  }),
  parse: async (output) => validateVerdict("split", output, splitResultSchema),
  onResult: async (task, result) => {
    task.artifacts.setJSON("acceptance.json", result)
    const subtaskChecks = result.subtasks?.length
      ? `\n## Subtask checks\n\n${result.subtasks
          .map(
            (s, i) =>
              `### ${i + 1}. ${s.title}\n\n${s.description}\n\n**Test path:** ${s.testPath}\n\n${s.acceptanceTest}\n`,
          )
          .join("\n")}`
      : ""
    task.artifacts.set(
      "acceptance.md",
      `# Acceptance check for ${task.ticket.key}\n\n**Test path:** ${result.testPath}\n\n${result.acceptanceTest}\n\n## Brief\n${result.brief}\n${subtaskChecks}`,
    )
    if (result.unverifiable !== undefined) {
      throw new EscalationError("needs-info", result.unverifiable)
    }
  },
})
