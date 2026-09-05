export type LogLevel = "debug" | "info" | "warn" | "error"

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(msg: string, ...args: unknown[]): void
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
  child(prefix: string): Logger
}

export function createLogger(level: LogLevel = "info"): Logger {
  const write = (lvl: LogLevel, prefix: string, msg: string, args: unknown[]) => {
    if (order[lvl] < order[level]) return
    const tag = prefix ? ` ${prefix}` : ""
    const line = `${new Date().toISOString()} [${lvl.toUpperCase()}]${tag} ${msg}`
    if (lvl === "error") console.error(line, ...args)
    else if (lvl === "warn") console.warn(line, ...args)
    else console.log(line, ...args)
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
