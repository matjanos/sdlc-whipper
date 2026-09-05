import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import type { LedgerStore, RollupKey, RollupRow } from "../../ports/index.js"
import type { LedgerEntry } from "../../types.js"

/**
 * JSONL ledger: one file, one line per model call, durable across ticks.
 * Rollups and per-run usage are computed in memory after loading the file —
 * simple, and plenty fast for the volumes a conductor produces.
 */
export class JsonlLedger implements LedgerStore {
  private entries: LedgerEntry[] = []
  private loaded = false
  private readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, "entries.jsonl")
  }

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.entries.push(JSON.parse(trimmed) as LedgerEntry)
      } catch {
        // tolerate a partially written line after a crash
      }
    }
  }

  async record(entry: LedgerEntry): Promise<void> {
    this.load()
    this.entries.push(entry)
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`)
  }

  async rollup(by: RollupKey, filter?: { ticket?: string }): Promise<RollupRow[]> {
    this.load()
    const groups = new Map<string, RollupRow>()
    const keyOf = (e: LedgerEntry): string => {
      switch (by) {
        case "ticket":
          return e.ticket
        case "phase":
          return e.phase
        case "agent":
          return e.agent
        case "run":
          return e.runId
      }
    }
    for (const e of this.entries) {
      if (filter?.ticket && e.ticket !== filter.ticket) continue
      const key = keyOf(e)
      const row = groups.get(key) ?? { key, runs: 0, tokens: 0, costUsd: 0 }
      row.runs += 1
      row.tokens += e.tokens.input + e.tokens.output + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheWrite ?? 0)
      row.costUsd += e.costUsd ?? 0
      groups.set(key, row)
    }
    return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
  }

  async usage(runId: string): Promise<{ tokens: number; costUsd: number }> {
    this.load()
    let tokens = 0
    let costUsd = 0
    for (const e of this.entries) {
      if (e.runId !== runId) continue
      tokens += e.tokens.input + e.tokens.output + (e.tokens.cacheRead ?? 0) + (e.tokens.cacheWrite ?? 0)
      costUsd += e.costUsd ?? 0
    }
    return { tokens, costUsd }
  }
}
