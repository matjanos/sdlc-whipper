import { describe, expect, it } from "vitest"
import { OpenCodeRuntime } from "../src/adapters/runtime-opencode/index.js"
import { JsonlLedger } from "../src/adapters/ledger-jsonl/index.js"
import { makeTempRepo } from "./helpers.js"

/**
 * Live smoke for the real OpenCode runtime — one trivial model call, no
 * pipeline, no repo mutation. Skipped unless explicitly requested:
 *
 *   SDL_LIVE_SMOKE=1 pnpm test -- test/runtime-live.spec.ts
 *
 * Optional env: SDL_LIVE_MODEL (provider/id, default zai-coding-plan/glm-5.3-flash).
 *
 * Purpose: pin the real server's model catalog (preflight), session handling,
 * and the usage-event → ledger feed — cheaply. If this breaks after an
 * opencode upgrade, extend the fixtures in runtime-payloads/runtime-usage
 * specs from the failure instead of debugging through full paid tick runs.
 */
const live = process.env.SDL_LIVE_SMOKE === "1"
const d = live ? describe : describe.skip

d("OpenCodeRuntime live smoke", () => {
  it("passes preflight, answers one prompt, and records usage in the ledger", async () => {
    const model = process.env.SDL_LIVE_MODEL ?? "zai-coding-plan/glm-5.3-flash"
    const { dir, config } = await makeTempRepo({ models: { reasoner: model } })
    const ledger = new JsonlLedger(`${dir}/.ledger-smoke`)
    const runtime = new OpenCodeRuntime({ config, fallbackDirectory: dir, ledger })
    try {
      // open() runs the model preflight against GET /api/model — a bogus
      // SDL_LIVE_MODEL fails here in seconds instead of hanging the session.
      await runtime.open({ runId: "smoke", ticket: "SMOKE", worktree: dir })
      const reply = await runtime.prompt("researcher", {
        text: "Reply with exactly: SMOKE-OK — and nothing else.",
      })
      expect(reply).toContain("SMOKE-OK")

      // usage events are asynchronous — poll briefly for the ledger entry
      let rows: { key: string; tokens: number }[] = []
      for (let i = 0; i < 20 && rows.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 500))
        rows = await ledger.rollup("ticket")
      }
      const smoke = rows.find((r) => r.key === "SMOKE")
      expect(smoke).toBeDefined()
      expect(smoke!.tokens).toBeGreaterThan(0)
    } finally {
      await runtime.close()
    }
  }, 300_000)
})
