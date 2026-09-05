import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import type { z } from "zod"
import type { Ticket } from "../types.js"

const promptsRoot = fileURLToPath(new URL("../../prompts", import.meta.url))

/** Load `prompts/phases/<name>.md` and substitute `{{var}}` placeholders. */
export function renderPrompt(name: string, vars: Record<string, string>): string {
  const file = path.join(promptsRoot, "phases", `${name}.md`)
  let template = readFileSync(file, "utf8")
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value)
  }
  // leave nothing ambiguous: an unsubstituted placeholder is a prompt bug
  template = template.replace(/\{\{[a-zA-Z]+\}\}/g, "")
  return template
}

/** Full ticket block — description + comments. Given to every phase that needs task context (never to council). */
export function formatTicket(ticket: Ticket): string {
  const lines: string[] = [
    `## Ticket ${ticket.key}: ${ticket.title}`,
    ticket.url ? `URL: ${ticket.url}` : "",
    `State: ${ticket.state}${ticket.labels.length ? ` | Labels: ${ticket.labels.join(", ")}` : ""}`,
    ticket.projectName ? `Project (batch): ${ticket.projectName}` : "",
    "",
    "### Description",
    ticket.description || "(empty)",
  ]
  if (ticket.comments.length) {
    lines.push("", "### Comments (oldest first — later comments amend the description)")
    for (const c of ticket.comments) {
      lines.push(`**${c.author}** (${c.createdAt}):\n${c.body}`)
    }
  }
  if (ticket.relations.length) {
    lines.push("", "### Relations")
    for (const r of ticket.relations) lines.push(`- ${r.kind} ${r.key} (${r.state})`)
  }
  return lines.filter((l) => l !== "").join("\n")
}

export class VerdictParseError extends Error {
  constructor(phase: string, detail: string) {
    super(`${phase}: cannot parse verdict from agent output — ${detail}`)
    this.name = "VerdictParseError"
  }
}

/** Extract the last fenced ```json block and parse it. Agents are instructed to end with a verdict block. */
export function extractVerdict<T>(phase: string, output: string): T {
  const blocks = [...output.matchAll(/```json\s*([\s\S]*?)```/g)]
  const last = blocks.at(-1)
  if (!last || !last[1]) {
    throw new VerdictParseError(phase, "no ```json fenced block found in output")
  }
  try {
    return JSON.parse(last[1]) as T
  } catch (err) {
    throw new VerdictParseError(phase, `invalid JSON: ${(err as Error).message}`)
  }
}

/** Extract + zod-validate; shape errors become VerdictParseError with precise detail. */
export function validateVerdict<S extends z.ZodTypeAny>(phase: string, output: string, schema: S): z.output<S> {
  const raw = extractVerdict<unknown>(phase, output)
  const result = schema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ")
    throw new VerdictParseError(phase, issues)
  }
  return result.data
}

export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[…truncated ${text.length - max} chars]`
}
