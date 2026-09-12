import type { Phase } from "./base.js"
import type { PhaseName } from "../types.js"
import { splitPhase } from "./split.js"
import { researchPhase } from "./research.js"
import { councilPhase } from "./council.js"
import { executePhase } from "./execute.js"
import { reviewPhase } from "./review.js"
import { publishPhase } from "./publish.js"
import { awaitPreviewPhase } from "./await-preview.js"
import { testPhase } from "./test.js"
import { groomPhase } from "./groom.js"

export type {
  Phase,
  SplitResult,
  ResearchResult,
  CouncilResult,
  ReviewFinding,
  ReviewResult,
  PublishResult,
  AwaitPreviewResult,
  TestResult,
  GroomResult,
  GroomClassification,
} from "./base.js"
export {
  splitResultSchema,
  researchResultSchema,
  councilResultSchema,
  reviewResultSchema,
  testResultSchema,
  groomResultSchema,
} from "./base.js"

/** Registry — pipelines reference phases by name; adding a phase = add file + entry here. */
export async function loadPhases(): Promise<Map<PhaseName, Phase<unknown>>> {
  const phases: Phase<unknown>[] = [
    splitPhase,
    researchPhase,
    councilPhase,
    executePhase,
    reviewPhase,
    publishPhase,
    awaitPreviewPhase,
    testPhase,
    groomPhase,
  ]
  const map = new Map<PhaseName, Phase<unknown>>()
  for (const p of phases) map.set(p.name, p)
  return map
}
