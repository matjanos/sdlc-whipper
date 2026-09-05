import type { PreviewEnvironment } from "../../ports/index.js"
import type { PreviewRef } from "../../types.js"

/** Instantly-ready fake preview: `https://pr-<n>-fake.preview.test`. */
export class FakePreview implements PreviewEnvironment {
  readonly urls: string[] = []

  urlFor(pr: number): string {
    return `https://pr-${pr}-fake.preview.test`
  }

  async previewFor(pr: number): Promise<PreviewRef> {
    return { url: this.urlFor(pr), status: "ready" }
  }

  async waitForReady(pr: number, _timeoutMs: number): Promise<PreviewRef> {
    const url = this.urlFor(pr)
    this.urls.push(url)
    return { url, status: "ready" }
  }
}
