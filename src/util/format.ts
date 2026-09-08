/** Human token units shared by the ledger skin and the progress loader. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/** `21:37:25` wall-clock stamp for the right edge of the terminal. */
export function formatClock(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8)
}

/** Append a muted right-edge timestamp to a rendered line (ANSI-aware width). */
export function stamp(
  line: string,
  options: { color?: boolean } = {},
  date: Date = new Date(),
): string {
  const clock = formatClock(date)
  const mark = options.color ? `\u001B[90m${clock}\u001B[0m` : clock
  // cap the pad: on ultrawide terminals a full-width gap looks broken
  const width = Math.min(process.stdout.columns ?? 80, 120)
  const visible = line.replace(/\u001B\[[0-9;]*m/g, "").length
  if (visible >= width - 9) return `${line}  ${mark}`
  return `${line}${" ".repeat(Math.max(2, width - 9 - visible))}${mark}`
}
