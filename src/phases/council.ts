import { renderPrompt, validateVerdict, truncate } from "./shared.js"
import { definePhase, councilResultSchema, type CouncilResult } from "./base.js"
import { EscalationError } from "../types.js"
import type { ResearchResult } from "./base.js"

/**
 * Council: a principal-engineer advisor for low-confidence plans.
 * CONTEXT FIREWALL: it receives the researcher's questions and plan — never the
 * full ticket, comments, or code. The firewall test asserts this.
 */
export const councilPhase = definePhase<CouncilResult>({
  name: "council",
  usesLLM: true,
  role: "council",
  input: async (_task, outcomes) => {
    const research = outcomes["research"] as ResearchResult | undefined
    if (!research) throw new Error("council: no research outcome present")
    return {
      text: renderPrompt("council", {
        questions: research.questions.map((q, i) => `${i + 1}. ${q}`).join("\n") || "(none listed)",
        plan: truncate(research.planMarkdown, 15_000),
      }),
    }
  },
  parse: async (output) => validateVerdict("council", output, councilResultSchema),
  onResult: async (task, result, outcomes) => {
    const research = outcomes["research"] as ResearchResult | undefined
    task.artifacts.append(
      "council.md",
      `## Council advice\n\n${result.advice}\n\n**needsHuman:** ${result.needsHuman}`,
    )
    if (result.needsHuman && research) {
      throw new EscalationError(
        "needs-info",
        research.questions.map((q, i) => `${i + 1}. ${q}`).join("\n"),
      )
    }
  },
})
