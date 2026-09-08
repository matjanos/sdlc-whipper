/**
 * Terminal loader for long waits (LLM phases). Zero dependencies, disabled
 * automatically outside a TTY (tests, CI, piped output) or via `--plain` —
 * so logs and captured output stay machine-clean.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const INTERVAL_MS = 90

export interface Spinner {
  start(text: string): void
  update(text: string): void
  /** Clear the loader line; `note` prints one final line when enabled. */
  stop(note?: string): void
}

let disabled = false

/** CLI calls this when `--plain` / NO_COLOR handling decides on a bare terminal. */
export function setProgressDisabled(value: boolean): void {
  disabled = value
}

function defaultEnabled(): boolean {
  return !disabled && Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined
}

export function createSpinner(opts: { enabled?: boolean; stream?: { write(text: string): void } } = {}): Spinner {
  const enabled = opts.enabled ?? defaultEnabled()
  const stream = opts.stream ?? process.stdout
  let timer: ReturnType<typeof setInterval> | undefined
  let frame = 0
  let text = ""
  let startedAt = 0

  const render = (): void => {
    const elapsed = formatElapsed(Date.now() - startedAt)
    stream.write(`\r\u001B[2K${FRAMES[frame % FRAMES.length]} ${text} · ${elapsed}`)
  }

  const api: Spinner = {
    start(initial: string): void {
      text = initial
      startedAt = Date.now()
      if (!enabled) return
      render()
      timer = setInterval(() => {
        frame += 1
        render()
      }, INTERVAL_MS)
      timer.unref?.()
    },
    update(next: string): void {
      text = next
      if (!enabled || !timer) return
      render()
    },
    stop(note?: string): void {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
      if (!enabled) return
      stream.write(`\r\u001B[2K`)
      if (note) stream.write(`${note}\n`)
    },
  }
  return api
}

/** `1:09` style — compact and scannable in logs. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
