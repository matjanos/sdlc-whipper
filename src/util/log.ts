import { clearActiveSpinnerLine, redrawActiveSpinnerLine, colorEnabled } from "./progress.js"
import { formatClock, stamp } from "./format.js"

export type LogLevel = "debug" | "info" | "warn" | "error"

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(prefix: string): Logger
}

export interface LoggerOptions {
  /** Compact, human-oriented output for interactive terminals. */
  pretty?: boolean
}

const tint: Record<LogLevel, (text: string) => string> = {
  debug: (t) => `\u001B[90m${t}\u001B[0m`, // bright black
  info: (t) => `\u001B[32m${t}\u001B[0m`, // green
  warn: (t) => `\u001B[33m${t}\u001B[0m`, // yellow
  error: (t) => `\u001B[31m${t}\u001B[0m`, // red
}

const mark = (lvl: LogLevel, colored: boolean): string => {
  const glyph: Record<LogLevel, string> = { debug: "·", info: "│", warn: "▲", error: "✕" }
  const g = glyph[lvl]
  return colored ? tint[lvl](g) : g
}

const faint = (text: string, colored: boolean): string =>
  colored ? `\u001B[90m${text}\u001B[0m` : text

export function createLogger(level: LogLevel = "info", options: LoggerOptions = {}): Logger {
  const write = (lvl: LogLevel, prefix: string, msg: string, args: unknown[]) => {
    if (order[lvl] < order[level]) return
    const colored = colorEnabled()
    let line: string
    if (options.pretty) {
      line = `  ${mark(lvl, colored)}${prefix ? ` ${prefix.padEnd(12)}` : ""} ${msg}`
      // muted wall-clock stamp pinned to the right edge — quiet, always there
      line = stamp(line, { color: colored })
    } else {
      // debug/machine mode: compact local time with ms — date lives in the ledger
      const now = new Date()
      const ms = String(now.getMilliseconds()).padStart(3, "0")
      line = `${faint(`${formatClock(now)}.${ms} ${lvl.toUpperCase()}`, colored)} ${msg}`
    }
    // share the cursor with the live spinner: clear its partial line, log,
    // then let the spinner redraw below the fresh log line
    clearActiveSpinnerLine()
    if (lvl === "error") console.error(line, ...args)
    else if (lvl === "warn") console.warn(line, ...args)
    else console.log(line, ...args)
    redrawActiveSpinnerLine()
  }
  const make = (prefix: string): Logger => ({
    debug: (m, ...a) => write("debug", prefix, m, a),
    info: (m, ...a) => write("info", prefix, m, a),
    warn: (m, ...a) => write("warn", prefix, m, a),
    error: (m, ...a) => write("error", prefix, m, a),
    child: (p: string) => make(prefix ? `${prefix}:${p}` : p),
  })
  return make("")
}
