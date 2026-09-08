/** Human token units shared by the ledger skin and the progress loader. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

/** `21:37:25` wall-clock stamp. */
export function formatClock(date: Date = new Date()): string {
  return date.toTimeString().slice(0, 8)
}

/** Extra-compact `21:37` variant for inline stamps. */
export function formatClockShort(date: Date = new Date()): string {
  return formatClock(date).slice(0, 5)
}

/** Append a concise muted timestamp right after the content: `… · 21:37`. */
export function stamp(
  line: string,
  options: { color?: boolean } = {},
  date: Date = new Date(),
): string {
  const mark = options.color ? `\u001B[90m${formatClockShort(date)}\u001B[0m` : formatClockShort(date)
  return `${line}  ${mark}`
}
