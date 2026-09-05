import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

/** Whatever Client.connect accepts — avoids depending on the SDK's internal Transport export path. */
type TransportLike = Parameters<Client["connect"]>[0]

/**
 * Minimal MCP client plumbing shared by MCP-based adapters (linear-mcp,
 * vercel-mcp). MCP is just another transport for a port — the conductor core
 * never sees it. Tests inject an in-memory transport.
 */
export interface McpEndpoint {
  url: string
  token?: string
  /** Extra headers (e.g. custom auth schemes). */
  headers?: Record<string, string>
  /** Injectable transport (tests); defaults to streamable HTTP against `url`. */
  transport?: TransportLike
}

export class McpToolbox {
  private client?: Client
  private namesCache?: Set<string>

  constructor(
    private readonly endpoint: McpEndpoint,
    private readonly label: string,
  ) {}

  async connect(): Promise<void> {
    if (this.client) return
    const headers: Record<string, string> = { ...this.endpoint.headers }
    if (this.endpoint.token) headers["Authorization"] = `Bearer ${this.endpoint.token}`
    const client = new Client({ name: "sdlc-conductor", version: "0.1.0" })
    const transport =
      this.endpoint.transport ??
      new StreamableHTTPClientTransport(new URL(this.endpoint.url), {
        requestInit: { headers },
      })
    try {
      await client.connect(transport)
    } catch (err) {
      throw new Error(`${this.label}: cannot connect to MCP server ${this.endpoint.url} — ${(err as Error).message}`)
    }
    this.client = client
  }

  private async names(): Promise<Set<string>> {
    await this.connect()
    if (!this.namesCache) {
      const res = await this.client!.listTools()
      this.namesCache = new Set(res.tools.map((t) => t.name))
    }
    return this.namesCache
  }

  /** MCP tool names drift across server versions — resolve by candidates, fail with the actual catalog. */
  async findTool(candidates: string[], purpose: string): Promise<string> {
    const names = await this.names()
    for (const candidate of candidates) {
      if (names.has(candidate)) return candidate
    }
    throw new Error(
      `${this.label}: no MCP tool found for ${purpose}. Tried: ${candidates.join(", ")}. ` +
        `Available: ${[...names].sort().join(", ")}`,
    )
  }

  /** Call a tool and return its text content parsed as JSON when possible. */
  async callJson<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.connect()
    const res = await this.client!.callTool({ name, arguments: args })
    const text = (res.content as { type: string; text?: string }[] | undefined)
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n")
    if (res.isError) {
      throw new Error(`${this.label}: MCP tool ${name} returned an error: ${text?.slice(0, 500)}`)
    }
    if (!text) throw new Error(`${this.label}: MCP tool ${name} returned no text content`)
    try {
      return JSON.parse(text) as T
    } catch {
      // some tools wrap payloads in markdown fences or prose
      const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      if (fenced?.[1]) {
        try {
          return JSON.parse(fenced[1]) as T
        } catch {
          /* fall through */
        }
      }
      throw new Error(
        `${this.label}: MCP tool ${name} returned non-JSON output (first 300 chars): ${text.slice(0, 300)}`,
      )
    }
  }

  async close(): Promise<void> {
    await this.client?.close()
    this.client = undefined
  }
}
