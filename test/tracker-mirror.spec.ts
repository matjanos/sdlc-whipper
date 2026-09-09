import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { nextBackoffMs, parseRetryAfterMs, TrackerMirror } from "../src/conductor/tracker-mirror.js"
import type { TicketTracker } from "../src/ports/index.js"
import type { Ticket } from "../src/types.js"

const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return this } } as never

function ticket(key: string, state = "backlog"): Ticket {
  return {
    key,
    title: `t ${key}`,
    description: "",
    comments: [],
    labels: [],
    state: state as Ticket["state"],
    relations: [],
  }
}

/** Counting tracker stub with programmable failures: calls before `failBefore` and after `failAfter` throw. */
function stubTracker(
  all: Ticket[],
  opts: { failBefore?: number; failAfter?: number; gate?: (i: number) => Promise<void> } = {},
): TicketTracker & { fetches: number } {
  let fetch = 0
  const failBefore = opts.failBefore ?? 0
  const failAfter = opts.failAfter ?? Number.MAX_SAFE_INTEGER
  return {
    get fetches() { return fetch },
    async discoverWorkspace() { return { teamKey: "TST", stateIds: {}, labelIds: {}, stateNameToLogical: {} } },
    async listIssues() {
      fetch++
      if (opts.gate) await opts.gate(fetch)
      if (fetch <= failBefore || fetch > failAfter) throw new Error("Rate limited. Retry after 3600 seconds")
      return all
    },
    async getTicket(key) { return all.find((t) => t.key === key) ?? ticket(key) },
    async comment() {},
    async addLabel() {},
    async moveTo() {},
    async setRelation() {},
    async createSubIssue() { return ticket("NEW") },
    async createIssue() { return ticket("NEW") },
  }
}

function makeMirror(tracker: TicketTracker, opts: Record<string, number | (() => number)> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sdlc-mirror-"))
  let t = 1_000_000
  const now = (opts.now as (() => number) | undefined) ?? (() => t)
  const mirror = new TrackerMirror(tracker, path.join(dir, "cache.json"), log, {
    maxAgeMs: (opts.maxAgeMs as number) ?? 60_000,
    minSpacingMs: (opts.minSpacingMs as number) ?? 1_000,
    backoffBaseMs: 1_000,
    backoffCapMs: 10_000,
    now,
  })
  return { mirror, advance: (ms: number) => { t += ms } }
}

describe("backoff policy", () => {
  it("grows exponentially and caps", () => {
    expect(nextBackoffMs(1, 15_000, 60_000)).toBe(15_000)
    expect(nextBackoffMs(2, 15_000, 60_000)).toBe(30_000)
    expect(nextBackoffMs(3, 15_000, 60_000)).toBe(60_000)
    expect(nextBackoffMs(9, 15_000, 60_000)).toBe(60_000)
  })
  it("parses tracker retry hints", () => {
    expect(parseRetryAfterMs("Rate limited. Retry after 3600 seconds")).toBe(3_600_000)
    expect(parseRetryAfterMs("retry after 30 s")).toBe(30_000)
    expect(parseRetryAfterMs("connection reset")).toBeUndefined()
  })
})

describe("tracker mirror", () => {
  it("serves local data when fresh and sweeps again when stale", async () => {
    const tracker = stubTracker([ticket("TST-1")])
    const { mirror, advance } = makeMirror(tracker)

    expect(await mirror.tickets()).toHaveLength(1)
    expect(await mirror.tickets()).toHaveLength(1)
    expect(tracker.fetches).toBe(5) // one sweep

    advance(61_000)
    expect(await mirror.tickets()).toHaveLength(1)
    expect(tracker.fetches).toBe(10) // second sweep
  })

  it("honors tracker retry hints instead of hammering", async () => {
    const tracker = stubTracker([ticket("TST-1")], { failBefore: 1 })
    const { mirror, advance } = makeMirror(tracker)

    await expect(mirror.tickets()).rejects.toThrow(/Retry after 3600 seconds/)
    const callsAfterFirst = tracker.fetches
    advance(9_000) // declared 3600s, capped by makeMirror to 10s — still inside the window
    await expect(mirror.tickets()).rejects.toThrow()
    expect(tracker.fetches).toBe(callsAfterFirst) // backoff holds: no new sweep

    advance(2_000) // window elapsed → retry (this stub now succeeds)
    expect(await mirror.tickets()).toHaveLength(1)
  })

  it("serves stale data with a degraded note when sweeps start failing", async () => {
    const tracker = stubTracker([ticket("TST-1")], { failAfter: 5 }) // first sweep ok, then throttled
    const { mirror, advance } = makeMirror(tracker)
    await mirror.tickets()

    advance(61_000) // stale → sweep fails → serve what we have
    expect(await mirror.tickets()).toHaveLength(1)
    expect(mirror.degraded()).toMatch(/Retry after 3600 seconds/)
    expect(mirror.degraded()).toBeTruthy()
  })

  it("collapses concurrent reads into one sweep", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const tracker = stubTracker([ticket("TST-1")], { gate: async (i) => { if (i === 1) await gate } })
    const { mirror } = makeMirror(tracker, { minSpacingMs: 0 })

    const p1 = mirror.tickets()
    const p2 = mirror.tickets()
    release()
    await Promise.all([p1, p2])
    expect(tracker.fetches).toBe(5)
  })

  it("persists across restarts: a fresh mirror serves without spending a sweep", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sdlc-mirror-"))
    const file = path.join(dir, "cache.json")
    const tracker = stubTracker([ticket("TST-1"), ticket("TST-2")])
    let t = 1_000_000
    const now = () => t
    const first = new TrackerMirror(tracker, file, log, { maxAgeMs: 60_000, minSpacingMs: 1, now })
    await first.tickets()
    t += 1_000

    const coldTracker = stubTracker([])
    const second = new TrackerMirror(coldTracker, file, log, { maxAgeMs: 60_000, minSpacingMs: 1, now })
    expect(await second.tickets()).toHaveLength(2)
    expect(coldTracker.fetches).toBe(0)
  })

  it("reconciles after a local change even while fresh", async () => {
    const tracker = stubTracker([ticket("TST-1")])
    const { mirror } = makeMirror(tracker, { minSpacingMs: 0 })
    await mirror.tickets()
    expect(tracker.fetches).toBe(5)

    mirror.noteLocalChange()
    await mirror.tickets()
    expect(tracker.fetches).toBe(10)
  })
})
