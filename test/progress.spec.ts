import { describe, expect, it, vi } from "vitest"
import {
  createSpinner,
  formatElapsed,
  clearActiveSpinnerLine,
  redrawActiveSpinnerLine,
  renderTrail,
} from "../src/util/progress.js"
import { stamp, formatClock } from "../src/util/format.js"

function fakeStream() {
  return { write: vi.fn(), written: () => stream.write.mock.calls.map((c) => String(c[0])).join("") }
}
const stream = fakeStream()

describe("spinner (terminal loader)", () => {
  it("is silent when disabled (CI, pipes, --plain)", () => {
    const s = createSpinner({ enabled: false, stream })
    s.start("split · executor — working")
    s.update("split — read src/x.ts")
    s.stop()
    expect(stream.written()).toBe("")
  })

  it("renders frames, text, and elapsed time; stop clears the line", () => {
    vi.useFakeTimers()
    const s = createSpinner({ enabled: true, stream })
    s.start("review · reviewer · glm-5.3 — working")
    vi.advanceTimersByTime(200)
    s.update("review — read src/store.js · 12.0k tok")
    s.stop()
    const out = stream.written()
    expect(out).toContain("review · reviewer · glm-5.3 — working")
    expect(out).toContain("read src/store.js · 12.0k tok")
    expect(out).toContain("\r\u001B[2K") // line-clear redraws and final clear
    expect(out.endsWith("\r\u001B[2K")).toBe(true)
    vi.useRealTimers()
  })

  it("stop(note) leaves a single final line", () => {
    const s = createSpinner({ enabled: true, stream })
    s.start("research · researcher")
    s.stop("✓ research 0:31")
    expect(stream.written().endsWith("✓ research 0:31\n")).toBe(true)
  })

  it("lets a logger share the cursor: clear before its line, redraw after", () => {
    vi.useFakeTimers()
    const s = createSpinner({ enabled: true, stream })
    s.start("execute · glm-5.3-flash — working")
    vi.advanceTimersByTime(90)
    clearActiveSpinnerLine()
    stream.write("  │ execute: ok (0:37)\n")
    redrawActiveSpinnerLine()
    const out = stream.written()
    // the log line must start at column 0, never glued to a spinner frame
    expect(out).toContain("\r\u001B[2K  │ execute: ok (0:37)\n")
    vi.useRealTimers()
    s.stop()
  })
})

describe("formatElapsed", () => {
  it("formats mm:ss", () => {
    expect(formatElapsed(0)).toBe("0:00")
    expect(formatElapsed(31_000)).toBe("0:31")
    expect(formatElapsed(69_000)).toBe("1:09")
  })
})

describe("trail and wall-clock stamps", () => {
  it("renders the route: done ✓, current ◉, ahead ○", () => {
    const line = renderTrail([
      { name: "split", state: "done" },
      { name: "execute", state: "current" },
      { name: "review", state: "todo" },
    ])
    expect(line).toBe("✓ split ─ ◉ execute ─ ○ review")
  })

  it("pads muted timestamps to the right edge without ANSI when color is off", () => {
    const line = stamp("🐎 WHIPPER", {}, new Date("2026-09-08T21:37:25"))
    expect(line).toContain("🐎 WHIPPER")
    expect(line).toContain("21:37:25")
    expect(line).not.toContain("\u001B[")
  })

  it("formatClock renders HH:MM:SS", () => {
    expect(formatClock(new Date("2026-09-08T21:37:25"))).toBe("21:37:25")
  })
})
