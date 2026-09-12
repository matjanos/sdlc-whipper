import { resolveModel, type ResolvedConfig } from "./config.js"
import type { AgentRole } from "./types.js"

export type DoctorStatus = "ok" | "fail" | "na"

export interface DoctorCheck {
  name: string
  status: DoctorStatus
  detail: string
  hint?: string
}

export interface DoctorReport {
  /** False iff any check failed — the CLI maps this to exit code 1. */
  ok: boolean
  checks: DoctorCheck[]
}

/** Pure assembly: stable check order, ok iff nothing failed (`na` never fails). */
export function buildDoctorReport(checks: DoctorCheck[]): DoctorReport {
  return { ok: checks.every((c) => c.status !== "fail"), checks }
}

export interface ModelClassProblem {
  role: AgentRole
  modelClass: string
}

/**
 * Every `agents.<role>.model` whose class is absent from `models`. Pure: the
 * unknown-class error from `resolveModel` becomes data a doctor check reports.
 */
export function modelClassProblems(config: ResolvedConfig): ModelClassProblem[] {
  const problems: ModelClassProblem[] = []
  for (const role of Object.keys(config.raw.agents) as AgentRole[]) {
    const modelClass = config.raw.agents[role]?.model
    if (!modelClass) continue
    try {
      resolveModel(config, role)
    } catch {
      problems.push({ role, modelClass })
    }
  }
  return problems
}
