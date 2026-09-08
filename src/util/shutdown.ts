import { stopActiveSpinners } from "./progress.js"

/**
 * Graceful shutdown for long-running commands: first Ctrl+C / SIGTERM stops
 * agent sessions, releases locks, and freezes the UI, then lets the stack
 * unwind; a second signal force-exits immediately.
 */
let shuttingDown = false

export function isShuttingDown(): boolean {
  return shuttingDown
}

export interface ShutdownHandlers {
  /** Best-effort cleanup: interrupt agent sessions, release the tick lock. */
  onInterrupt: () => Promise<void> | void
}

export function installShutdownHandlers(handlers: ShutdownHandlers): void {
  const handle = (signal: string): void => {
    if (shuttingDown) {
      process.exit(130) // second signal: the user wants out now
    }
    shuttingDown = true
    stopActiveSpinners()
    process.stderr.write(`\n⏳ ${signal} — stopping gracefully: interrupting agent sessions, releasing lock…\n`)
    void (async () => {
      try {
        await handlers.onInterrupt()
      } catch {
        /* best effort */
      }
      process.exitCode = 130
      // nothing may hang the exit (sleep loops, long polls)
      setTimeout(() => process.exit(130), 5_000).unref()
    })()
  }
  process.on("SIGINT", () => handle("SIGINT"))
  process.on("SIGTERM", () => handle("SIGTERM"))
}
