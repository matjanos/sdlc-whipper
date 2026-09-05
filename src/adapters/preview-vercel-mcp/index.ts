import type { PreviewEnvironment } from "../../ports/index.js"
import type { PreviewRef } from "../../types.js"
import { sleep } from "../../util/exec.js"
import { McpToolbox } from "../mcp/client.js"

export interface VercelMcpPreviewOptions {
  /** Fallback URL template when MCP is unavailable: "https://pr-{n}-{project}.vercel.app". */
  urlTemplate: string
  project: string
  /** Vercel project id (config for the deployments tool). */
  projectId?: string
  teamId?: string
  mcpUrl?: string
  token?: string
  pollMs?: number
}

/**
 * Preview adapter speaking Vercel's MCP: deployment state comes from
 * `list_deployments` matched to the PR, with the URL probe as an automatic
 * fallback. Provisioning/teardown remain owned by the target repo's pipeline
 * — this is still observation-only, just better-informed than the probe.
 */
export class VercelMcpPreview implements PreviewEnvironment {
  private readonly tb: McpToolbox

  constructor(private readonly opts: VercelMcpPreviewOptions) {
    const url = opts.mcpUrl ?? process.env["VERCEL_MCP_URL"] ?? "https://mcp.vercel.com/mcp"
    const token = opts.token ?? process.env["VERCEL_MCP_TOKEN"] ?? ""
    this.tb = new McpToolbox({ url, token }, "vercel-mcp")
  }

  fallbackUrl(pr: number): string {
    return this.opts.urlTemplate.replaceAll("{n}", String(pr)).replaceAll("{project}", this.opts.project)
  }

  async previewFor(pr: number): Promise<PreviewRef | undefined> {
    const url = this.fallbackUrl(pr)
    try {
      const tool = await this.tb.findTool(["list_deployments", "vercel_list_deployments"], "list deployments")
      const raw = await this.tb.callJson<Record<string, unknown>>(tool, {
        projectId: this.opts.projectId,
        teamId: this.opts.teamId,
        limit: 20,
      })
      const deployments = extractDeployments(raw)
      const match =
        deployments.find((d) => d.prId === pr) ??
        deployments.find((d) => d.url?.includes(`pr-${pr}`) || d.name?.includes(`pr-${pr}`))
      if (match?.readyState) {
        const status: PreviewRef["status"] =
          match.readyState === "READY"
            ? "ready"
            : match.readyState === "ERROR" || match.readyState === "CANCELED"
              ? "error"
              : "building"
        return { url: match.url ? `https://${match.url.replace(/^https?:\/\//, "")}` : url, status }
      }
    } catch {
      // MCP unavailable/mismatched → fall back to probing the stable URL
    }
    try {
      const res = await fetch(url, { method: "HEAD", redirect: "follow" })
      if (res.ok) return { url, status: "ready" }
      if (res.status === 401 || res.status === 403) return { url, status: "ready" } // protected preview — tester may hold credentials
      return { url, status: "building" }
    } catch {
      return { url, status: "building" }
    }
  }

  async waitForReady(pr: number, timeoutMs: number): Promise<PreviewRef> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const ref = await this.previewFor(pr)
      if (ref?.status === "ready") return ref
      if (ref?.status === "error") throw new Error(`preview for PR #${pr} failed to build: ${ref.url}`)
      if (Date.now() >= deadline) {
        throw new Error(`preview for PR #${pr} not ready after ${Math.round(timeoutMs / 60_000)}min: ${ref?.url}`)
      }
      await sleep(this.opts.pollMs ?? 10_000)
    }
  }
}

interface DeploymentLike {
  url?: string
  name?: string
  readyState?: string
  prId?: number
}

function extractDeployments(raw: unknown): DeploymentLike[] {
  const out: DeploymentLike[] = []
  const visit = (value: unknown, depth = 0): void => {
    if (value == null || depth > 3) return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1)
      return
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>
      if (typeof obj["readyState"] === "string" || typeof obj["url"] === "string") {
        const meta = (obj["meta"] ?? {}) as Record<string, unknown>
        const prId = Number(meta["githubPrId"] ?? meta["prId"] ?? NaN)
        out.push({
          url: typeof obj["url"] === "string" ? obj["url"] : undefined,
          name: typeof obj["name"] === "string" ? obj["name"] : undefined,
          readyState: typeof obj["readyState"] === "string" ? obj["readyState"] : undefined,
          prId: Number.isFinite(prId) ? prId : undefined,
        })
        return
      }
      for (const key of ["deployments", "nodes", "items", "results", "data"]) {
        if (key in obj) visit(obj[key], depth + 1)
      }
    }
  }
  visit(raw)
  return out
}
