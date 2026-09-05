import type { PreviewRef } from "../types.js"

/**
 * Preview environment port. Default adapter: Vercel (+ Neon branch DB) driven
 * by the target repo's existing preview pipeline — that pipeline owns
 * provisioning and teardown, so the default adapter is observation-first:
 * it resolves the stable per-PR URL and waits for it to become ready.
 * A provider that owns provisioning itself (e.g. Railway PR environments)
 * implements `provision` instead.
 */
export interface PreviewEnvironment {
  previewFor(pr: number): Promise<PreviewRef | undefined>

  waitForReady(pr: number, timeoutMs: number): Promise<PreviewRef>

  provision?(pr: number): Promise<PreviewRef>
}
