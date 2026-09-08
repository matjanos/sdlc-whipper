import { describe, expect, it } from "vitest"
import { OpenCodeRuntime } from "../src/adapters/runtime-opencode/index.js"
import { makeTempRepo } from "./helpers.js"

/**
 * Live smoke for the real OpenCode runtime — one trivial model call, no
 * pipeline, no repo mutation. Skipped unless explicitly requested:
 *
 *   SDL_LIVE_SMOKE=1 pnpm test -- test/runtime-live.spec.ts
 *
 * Optional env: SDL_LIVE_MODEL (provider/id, default zai-coding-plan/glm-5.3-flash).
 *
 * Purpose: pin the real server's session/model/message shapes cheaply. If this
 * breaks after an opencode upgrade, extend test/runtime-payloads.spec.ts from
 * the failure instead of debugging through full paid tick runs.
 */
const live = process.env.SDL_LIVE_SMOKE === "1"
const d = live ? describe : describe.skip

d("OpenCodeRuntime live smoke", () => {
  it("creates a session, sets the configured model, and extracts the assistant reply", async () => {
    const model = process.env.SDL_LIVE_MODEL ?? "zai-coding-plan/glm-5.3-flash"
    const { dir, config } = await makeTempRepo({ models: { reasoner: model } })
    const runtime = new OpenCodeRuntime({ config, fallbackDirectory: dir })
    try {
      await runtime.open({ runId: "smoke", ticket: "SMOKE", worktree: dir })
      const reply = await runtime.prompt("researcher", {
        text: "Reply with exactly: SMOKE-OK — and nothing else.",
      })
      expect(reply).toContain("SMOKE-OK")
    } finally {
      await runtime.close()
    }
  }, 300_000)
})
