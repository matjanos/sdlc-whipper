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

/** Shared TTY/NO_COLOR gate for ANSI accents (logger stamps, trail, spinner). */
export function colorEnabled(): boolean {
  return !disabled && Boolean(process.stdout.isTTY) && process.env["NO_COLOR"] === undefined
}

/** Live spinners — the shutdown coordinator freezes them for a clean last frame. */
const active = new Set<{ clear(): void }>()

export function stopActiveSpinners(): void {
  for (const spinner of active) spinner.clear()
  active.clear()
  rendering = undefined
}

/**
 * The currently rendering spinner line, if any. Loggers call
 * `clearActiveSpinnerLine()` before writing a line and
 * `redrawActiveSpinnerLine()` after, so live UI and logs share one cursor
 * without clobbering each other.
 */
let rendering: { clear(): void; render(): void } | undefined

export function clearActiveSpinnerLine(): void {
  rendering?.clear()
}

export function redrawActiveSpinnerLine(): void {
  rendering?.render()
}

function defaultEnabled(): boolean {
  return colorEnabled()
}

export interface TrailStep {
  name: string
  state: "done" | "current" | "todo"
}

/** The delivery route as a quiet track: ✓ done ─ ◉ just finished ─ ○ ahead. */
export function renderTrail(steps: TrailStep[]): string {
  const c = colorEnabled()
  const paint = (code: number, text: string): string => (c ? `\u001B[${code}m${text}\u001B[0m` : text)
  return steps
    .map((step) => {
      if (step.state === "done") return paint(32, `✓ ${step.name}`)
      if (step.state === "current") return paint(1, paint(36, `◉ ${step.name}`))
      return paint(90, `○ ${step.name}`)
    })
    .join(paint(90, " ─ "))
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

  const clear = (): void => {
    if (!enabled) return
    stream.write(`\r\u001B[2K`)
  }

  // While rendering, route logger writes around this line (see log.ts).
  const renderer = {
    clear,
    render: () => {
      if (!enabled || !timer) return
      render()
    },
  }

  const handle = { clear }

  const api: Spinner = {
    start(initial: string): void {
      text = initial
      startedAt = Date.now()
      if (!enabled) return
      active.add(handle)
      rendering = renderer
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
      active.delete(handle)
      if (rendering === renderer) rendering = undefined
      if (!enabled) return
      clear()
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
