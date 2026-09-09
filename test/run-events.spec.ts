import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { readRunEvents, RunEventLog } from "../src/conductor/run-events.js"

describe("run event timeline", () => {
  it("appends structured events and collapses identical adjacent activity", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sdlc-events-"))
    const log = new RunEventLog(dir, "run-1", "TST-1")
    log.append({ level: "info", phase: "execute", role: "executor", text: "phase started" })
    log.append({ level: "debug", phase: "execute", role: "executor", text: "read src/app.ts", tokens: 1200 })
    log.append({ level: "debug", phase: "execute", role: "executor", text: "read src/app.ts", tokens: 1200 })
    log.append({ level: "info", phase: "execute", role: "executor", text: "phase completed in 0:42" })

    const rows = readRunEvents(path.join(dir, "events.jsonl"))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ runId: "run-1", ticket: "TST-1", phase: "execute" })
    expect(rows[1]).toMatchObject({ text: "read src/app.ts", tokens: 1200 })
  })

  it("ignores interrupted final writes and returns a bounded tail", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sdlc-events-"))
    const file = path.join(dir, "events.jsonl")
    const rows = Array.from({ length: 5 }, (_, i) => JSON.stringify({
      runId: "r", ticket: "TST-1", ts: `2026-01-01T00:00:0${i}.000Z`, level: "info", text: `event ${i}`,
    }))
    writeFileSync(file, `${rows.join("\n")}\n{"partial"`)

    expect(readRunEvents(file, 2).map((e) => e.text)).toEqual(["event 3", "event 4"])
  })
})
