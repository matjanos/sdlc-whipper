import type { Logger } from "../util/log.js"
import { isShuttingDown } from "../util/shutdown.js"

/**
 * Transient-error classification + bounded retry for LLM calls. Network-level
 * failures (connection resets, timeouts, 5xx) are expected in long agent runs;
 * the conductor retries them in code with backoff — never an LLM's judgement,
 * never unbounded.
 */
export function isTransient(err: unknown): boolean {
  const parts: string[] = []
  let cursor: unknown = err
  for (let depth = 0; cursor && depth < 5; depth++) {
    const e = cursor as { name?: string; message?: string; cause?: unknown; code?: string }
    if (e.name) parts.push(e.name)
    if (e.code) parts.push(String(e.code))
    if (e.message) parts.push(e.message)
    cursor = e.cause
  }
  const text = parts.join(" ")
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|network|timeout|timed out|fetch failed|aborted|5\d\d\b|overloaded|rate limit|Transport/i.test(
    text,
  )
}

export interface RetryOptions {
  retries: number
  baseDelayMs: number
  log?: Logger
  label?: string
  /** Test seam. */
  delay?: (ms: number) => Promise<void>
}

export async function withTransientRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let lastError: unknown
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (isShuttingDown()) throw err // user interrupt: never retry against a stopping world
      if (attempt === opts.retries || !isTransient(err)) throw err
      const waitMs = opts.baseDelayMs * 2 ** attempt
      opts.log?.warn(
        `${opts.label ?? "call"}: transient error (${(err as Error).message?.slice(0, 120)}) — retry ${attempt + 1}/${opts.retries} in ${waitMs}ms`,
      )
      await delay(waitMs)
    }
  }
  throw lastError
}
