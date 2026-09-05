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

export interface SplitResult {
  acceptanceTest: string
  testPath: string
  brief: string
}
export const splitResultSchema = z.object({
  acceptanceTest: z.string().min(1),
  testPath: z.string().min(1),
  brief: z.string(),
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

export interface GroomResult {
  selected: string[]
  relations: { from: string; to: string; kind: "blocks" | "blocked-by" | "relates" }[]
  splits: { parentKey: string; drafts: { title: string; description: string }[] }[]
  questions: { key: string; body: string }[]
}
export const groomResultSchema = z.object({
  selected: z.array(z.string()).default([]),
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
