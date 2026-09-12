import { z } from "zod"
import type { AgentRole, PhaseName, PromptParts } from "../types.js"
import type { Outcomes, TaskContext } from "../conductor/deps.js"

/**
 * A phase is the only place a phase's context is assembled (context firewall),
 * the only place its verdict is parsed, and the only place its side effects
 * happen — through dry-run-aware actions. Base module: no phase imports here,
 * so phases + registry never cycle.
 */
export interface Phase<R = unknown> {
  name: PhaseName
  /** LLM phase (input→prompt→parse) or pure conductor step (run). */
  usesLLM: boolean
  role?: AgentRole
  /** Prompt assembly — THE context firewall for this phase. */
  input?(task: TaskContext, outcomes: Outcomes): Promise<PromptParts>
  /** Validate the agent's verdict. Throw VerdictParseError on garbage. */
  parse?(output: string, task: TaskContext): Promise<R>
  /** Pure phases implement this instead of input/parse. */
  run?(task: TaskContext, outcomes: Outcomes): Promise<R>
  /** Side effects after a successful result. */
  onResult?(task: TaskContext, result: R, outcomes: Outcomes): Promise<void>
}

export function definePhase<R>(phase: Phase<R>): Phase<R> {
  return phase
}

export interface SplitSubtask {
  title: string
  description: string
  acceptanceTest: string
  testPath: string
}
export interface SplitResult {
  acceptanceTest: string
  testPath: string
  brief: string
  /** Only for genuinely multi-part work — each part independently deliverable + testable. */
  subtasks?: SplitSubtask[]
  /** Escape hatch: set (with a reason) when no deterministic acceptance check can exist. */
  unverifiable?: string
}
export const splitResultSchema = z
  .object({
    acceptanceTest: z.string(),
    testPath: z.string(),
    brief: z.string(),
    subtasks: z
      .array(
        z.object({
          title: z.string().min(1),
          description: z.string().min(1),
          acceptanceTest: z.string().min(1),
          testPath: z.string().min(1),
        }),
      )
      .min(2, "a one-item subtasks array is not a decomposition — minimum is 2")
      .optional(),
    unverifiable: z.string().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.unverifiable !== undefined) return
    if (!val.acceptanceTest.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptanceTest"],
        message: "required unless unverifiable explains why no deterministic check can be defined",
      })
    }
    if (!val.testPath.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["testPath"],
        message: "required unless unverifiable explains why no deterministic check can be defined",
      })
    }
  })

export interface ResearchResult {
  confidence: "low" | "high"
  questions: string[]
  planMarkdown: string
}
export const researchResultSchema = z.object({
  confidence: z.enum(["low", "high"]),
  questions: z.array(z.string()),
  planMarkdown: z.string().min(1),
})

export interface CouncilResult {
  advice: string
  needsHuman: boolean
}
export const councilResultSchema = z.object({
  advice: z.string(),
  needsHuman: z.boolean(),
})

export interface ReviewFinding {
  severity: "blocker" | "major" | "minor"
  file?: string
  issue: string
  suggestion?: string
}
export interface ReviewResult {
  verdict: "approve" | "changes_requested"
  findings: ReviewFinding[]
}
export const reviewResultSchema = z.object({
  verdict: z.enum(["approve", "changes_requested"]),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        file: z.string().optional(),
        issue: z.string(),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
})

export interface PublishResult {
  skipped: boolean
  pr?: { number: number; url: string }
}

export interface AwaitPreviewResult {
  skipped: boolean
  url?: string
}

export interface TestResult {
  pass: boolean
  evidence: string
}
export const testResultSchema = z.object({
  pass: z.boolean(),
  evidence: z.string(),
})

export interface GroomClassification {
  key: string
  status: "ready" | "needs-info" | "blocked"
  /** One human-readable sentence: why this ticket got this status. */
  reason: string
  /** 0.0–1.0 — how sure the groomer is that this ticket can be delivered autonomously as written. */
  confidence: number
}
/** A ticket may only be selected when its classification is "ready" with confidence ≥ this. Enforced in the schema. */
export const GROOM_SELECT_MIN_CONFIDENCE = 0.7

export interface GroomResult {
  selected: string[]
  classifications: GroomClassification[]
  relations: { from: string; to: string; kind: "blocks" | "blocked-by" | "relates" }[]
  splits: { parentKey: string; drafts: { title: string; description: string }[] }[]
  questions: { key: string; body: string }[]
}
export const groomResultSchema = z
  .object({
    selected: z.array(z.string()).default([]),
    classifications: z.array(
      z.object({
        key: z.string().min(1),
        status: z.enum(["ready", "needs-info", "blocked"]),
        reason: z.string().min(1),
        confidence: z.number().min(0).max(1),
      }),
    ),
    relations: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          kind: z.enum(["blocks", "blocked-by", "relates"]),
        }),
      )
      .default([]),
    splits: z
      .array(
        z.object({
          parentKey: z.string(),
          drafts: z.array(z.object({ title: z.string(), description: z.string() })).min(1),
        }),
      )
      .default([]),
    questions: z.array(z.object({ key: z.string(), body: z.string() })).default([]),
  })
  .superRefine((val, ctx) => {
    const byKey = new Map(val.classifications.map((c) => [c.key, c]))
    for (const key of val.selected) {
      const c = byKey.get(key)
      if (!c || c.status !== "ready" || c.confidence < GROOM_SELECT_MIN_CONFIDENCE) {
        const detail = !c
          ? "no classification exists for it"
          : c.status !== "ready"
            ? `its classification is "${c.status}", not "ready"`
            : `its confidence is ${c.confidence}, below the minimum ${GROOM_SELECT_MIN_CONFIDENCE}`
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selected", key],
          message: `${key} cannot be selected — ${detail}; low confidence means ask (needs-info), never select`,
        })
      }
    }
    const questionKeys = new Set(val.questions.map((q) => q.key))
    for (const c of val.classifications) {
      if (c.status === "needs-info" && !questionKeys.has(c.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["classifications", c.key],
          message: `${c.key} is classified needs-info but has no matching entry in questions — every ask must carry the actual questions`,
        })
      }
    }
  })
