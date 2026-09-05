import { definePhase, type AwaitPreviewResult } from "./base.js"
import type { PublishResult } from "./base.js"

/**
 * Await preview (pure conductor step): wait for CI checks, then for the stable
 * per-PR preview URL. Provisioning/teardown is owned by the target repo's
 * pipeline (preview.yml + Vercel/Neon); this only observes — that is the
 * PreviewEnvironment port's observation-first contract.
 */
export const awaitPreviewPhase = definePhase<AwaitPreviewResult>({
  name: "await-preview",
  usesLLM: false,
  run: async (task, outcomes) => {
    const publish = outcomes["publish"] as PublishResult | undefined
    if (!publish || publish.skipped || !publish.pr) return { skipped: true }
    const pr = publish.pr.number
    task.deps.log.info(`await-preview: waiting for checks on PR #${pr}`)
    const checks = await task.deps.codehost.waitForChecks(pr, 20 * 60_000)
    if (checks.status === "fail") {
      throw new Error(`await-preview: CI checks failed on PR #${pr}: ${checks.summary}`)
    }
    task.deps.log.info(`await-preview: checks ${checks.status}, waiting for preview URL`)
    const preview = await task.deps.preview.waitForReady(pr, task.deps.config.raw.preview.readyTimeoutMs)
    task.artifacts.set("preview.txt", preview.url)
    return { skipped: false, url: preview.url }
  },
})
