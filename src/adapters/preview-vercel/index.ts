import type { PreviewEnvironment } from "../../ports/index.js"
import type { PreviewRef } from "../../types.js"
import { sleep } from "../../util/exec.js"

export interface VercelPreviewOptions {
  /** e.g. "https://pr-{n}-{project}.vercel.app" — {n}=PR number, {project}=project name. */
  urlTemplate: string
  project: string
  pollMs?: number
}

/**
 * Vercel preview adapter — observation-first. Provisioning and teardown are
 * owned by the target repo's pipeline (preview.yml: one environment per PR,
 * Neon branch reset from main, stable alias URL, deleted on close). This
 * adapter resolves the stable URL and waits until it serves traffic.
 *
 * To swap in a provider that owns provisioning (e.g. Railway PR environments),
 * implement `provision()` instead — the port allows both.
 */
export class VercelPreview implements PreviewEnvironment {
  constructor(private readonly opts: VercelPreviewOptions) {}

  urlFor(pr: number): string {
    return this.opts.urlTemplate.replaceAll("{n}", String(pr)).replaceAll("{project}", this.opts.project)
  }

  async previewFor(pr: number): Promise<PreviewRef | undefined> {
    const url = this.urlFor(pr)
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow" })
      if (res.ok) return { url, status: "ready" }
      if (res.status === 404 || res.status === 408 || res.status >= 500) return { url, status: "building" }
      // Auth-required previews (deployment protection): treat as ready — the
      // tester may hold credentials. See README → deployment protection.
      return { url, status: "ready" }
    } catch {
      return { url, status: "building" }
    }
  }

  async waitForReady(pr: number, timeoutMs: number): Promise<PreviewRef> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const ref = await this.previewFor(pr)
      if (ref && ref.status === "ready") return ref
      if (Date.now() >= deadline) {
        throw new Error(`preview for PR #${pr} not ready after ${Math.round(timeoutMs / 60_000)}min: ${ref?.url}`)
      }
      await sleep(this.opts.pollMs ?? 10_000)
    }
  }
}
