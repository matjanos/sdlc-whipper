import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { LogLevel } from "../util/log.js"

/** A safe, local execution event. Prompts and model output are deliberately excluded. */
export interface RunEvent {
  runId: string
  ticket: string
  ts: string
  level: LogLevel
  phase?: string
  role?: string
  text: string
  tokens?: number
}

/** Append-only local timeline for one ticket's runs. */
export class RunEventLog {
  private readonly file: string
  private lastFingerprint = ""

  constructor(
    directory: string,
    private readonly runId: string,
    private readonly ticket: string,
  ) {
    this.file = path.join(directory, "events.jsonl")
  }

  append(event: Omit<RunEvent, "runId" | "ticket" | "ts">): void {
    // activityFeed subscriptions can overlap when a bounded phase repeats;
    // collapse identical adjacent observations without hiding real changes.
    const fingerprint = JSON.stringify(event)
    if (fingerprint === this.lastFingerprint) return
    this.lastFingerprint = fingerprint
    mkdirSync(path.dirname(this.file), { recursive: true })
    const row: RunEvent = { runId: this.runId, ticket: this.ticket, ts: new Date().toISOString(), ...event }
    appendFileSync(this.file, `${JSON.stringify(row)}\n`)
  }
}

/** Read the newest bounded set of valid events. Partial final writes are ignored. */
export function readRunEvents(file: string, limit = 120): RunEvent[] {
  if (!existsSync(file)) return []
  const rows: RunEvent[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as RunEvent
      if (row.runId && row.ticket && row.ts && row.text) rows.push(row)
    } catch {
      /* interrupted append — ignore only the malformed row */
    }
  }
  return rows.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-limit)
}
