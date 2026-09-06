import { describe, expect, it } from "vitest"
import { isTransient, withTransientRetry } from "../src/conductor/retry.js"

describe("transient classification", () => {
  it("recognizes network-level failures through cause chains", () => {
    expect(isTransient(new Error("Transport"))).toBe(true)
    expect(isTransient(new Error("fetch failed"))).toBe(true)
    expect(
      isTransient(
        Object.assign(new Error("request failed"), {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        }),
      ),
    ).toBe(true)
    expect(isTransient(Object.assign(new Error("boom"), { code: "ETIMEDOUT" }))).toBe(true)
  })

  it("does not classify logic errors as transient", () => {
    expect(isTransient(new Error("no ```json fenced block found in output"))).toBe(false)
    expect(isTransient(new TypeError("cannot read properties of undefined"))).toBe(false)
  })
})

describe("withTransientRetry", () => {
  const instant = async () => undefined

  it("retries transient errors and succeeds within the bound", async () => {
    let calls = 0
    const result = await withTransientRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error("socket closed")
        return "ok"
      },
      { retries: 3, baseDelayMs: 1, delay: instant },
    )
    expect(result).toBe("ok")
    expect(calls).toBe(3)
  })

  it("gives up at the bound and reports the last error", async () => {
    let calls = 0
    await expect(
      withTransientRetry(
        async () => {
          calls += 1
          throw new Error("ECONNRESET")
        },
        { retries: 2, baseDelayMs: 1, delay: instant },
      ),
    ).rejects.toThrow(/ECONNRESET/)
    expect(calls).toBe(3) // initial + 2 retries
  })

  it("never retries non-transient errors", async () => {
    let calls = 0
    await expect(
      withTransientRetry(
        async () => {
          calls += 1
          throw new TypeError("bad verdict shape")
        },
        { retries: 5, baseDelayMs: 1, delay: instant },
      ),
    ).rejects.toThrow(TypeError)
    expect(calls).toBe(1)
  })
})
