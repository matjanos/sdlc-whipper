/** Tiny argv parser — the CLI surface is small on purpose. */
export interface ParsedArgs {
  command: string | undefined
  positional: string[]
  flags: Map<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | boolean>()
  let command: string | undefined
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]!
    if (arg.startsWith("--")) {
      const body = arg.slice(2)
      const equals = body.indexOf("=")
      if (equals > 0) {
        flags.set(body.slice(0, equals), body.slice(equals + 1))
        i += 1
        continue
      }
      const name = body
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next)
        i += 2
      } else {
        flags.set(name, true)
        i += 1
      }
    } else {
      if (command === undefined) command = arg
      else positional.push(arg)
      i += 1
    }
  }
  return { command, positional, flags }
}

export function flagString(flags: Map<string, string | boolean>, name: string): string | undefined {
  const v = flags.get(name)
  return typeof v === "string" ? v : undefined
}

export function flagBool(flags: Map<string, string | boolean>, name: string): boolean {
  const v = flags.get(name)
  return v === true || v === "true"
}
