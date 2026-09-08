import { clearActiveSpinnerLine, redrawActiveSpinnerLine } from "./progress.js"

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

export function createLogger(level: LogLevel = "info", options: LoggerOptions = {}): Logger {
  const write = (lvl: LogLevel, prefix: string, msg: string, args: unknown[]) => {
    if (order[lvl] < order[level]) return
    const tag = prefix ? ` ${prefix}` : ""
    const glyph: Record<LogLevel, string> = { debug: "·", info: "│", warn: "!", error: "×" }
    const line = options.pretty
      ? `  ${glyph[lvl]}${prefix ? ` ${prefix.padEnd(12)}` : ""} ${msg}`
      : `${new Date().toISOString()} [${lvl.toUpperCase()}]${tag} ${msg}`
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
