import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { ResolvedConfig } from "../../config.js"
import { resolveModel } from "../../config.js"
import type { AgentRole } from "../../types.js"

const promptsRoot = fileURLToPath(new URL("../../../prompts", import.meta.url))

export const AGENT_ID_PREFIX = "sdlc-"

export function agentId(role: AgentRole): string {
  return `${AGENT_ID_PREFIX}${role}`
}

/**
 * Per-role permission policy (plan §5). Least privilege: the reviewer cannot
 * edit or run anything; the executor cannot push (the conductor pushes);
 * the council cannot touch the repo at all.
 */
const PERMISSIONS: Record<AgentRole, unknown[]> = {
  groomer: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  split: [
    { action: "edit", resource: "tests/**", effect: "allow" },
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "git push*", effect: "deny" },
  ],
  researcher: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  council: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  executor: [{ action: "shell", resource: "git push*", effect: "deny" }],
  reviewer: [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "deny" },
    { action: "subagent", resource: "*", effect: "deny" },
  ],
  tester: [{ action: "edit", resource: "*", effect: "deny" }],
}

const ROLE_DESCRIPTION: Record<AgentRole, string> = {
  groomer: "Grooms the backlog: readiness checks, questions for humans, dependency graph, batching, splits",
  split: "Turns a ticket into a deterministic acceptance check (failing test first)",
  researcher: "Reads the codebase and produces an execution plan with a confidence signal",
  council: "Principal-engineer advisor for low-confidence plans; advisory only",
  executor: "Implements the plan in the worktree efficiently and precisely",
  reviewer: "Reviews the diff against the task; verdict only, no edits",
  tester: "Runs the acceptance check against the live preview environment",
}

function systemPrompt(role: AgentRole): string {
  return readFileSync(path.join(promptsRoot, "agents", `${role}.md`), "utf8")
}

export interface AgentDefinition {
  description: string
  mode: "primary"
  system: string
  permissions: unknown[]
  model?: string
}

export function buildAgentDefinitions(config: ResolvedConfig): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {}
  const roles: AgentRole[] = ["groomer", "split", "researcher", "council", "executor", "reviewer", "tester"]
  for (const role of roles) {
    const def: AgentDefinition = {
      description: ROLE_DESCRIPTION[role],
      mode: "primary",
      system: systemPrompt(role),
      permissions: PERMISSIONS[role],
    }
    const model = resolveModel(config, role)
    if (model) def.model = model
    agents[agentId(role)] = def
  }
  return agents
}

/**
 * Write the conductor's agent definitions into the task worktree as
 * `.opencode/opencode.json` (merged over anything the repo already declares).
 * This is what keeps the target repo footprint at zero: agents ride along
 * with the worktree, are never committed (publish excludes .opencode), and
 * die with the worktree.
 */
export function writeWorktreeAgentConfig(config: ResolvedConfig, worktree: string): void {
  const dir = path.join(worktree, ".opencode")
  const file = path.join(dir, "opencode.json")
  let existing: Record<string, unknown> = {}
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }
  const agents = {
    ...(existing["agents"] as Record<string, unknown> | undefined),
    ...buildAgentDefinitions(config),
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ ...existing, agents }, null, 2))
}
