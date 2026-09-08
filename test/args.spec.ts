import { describe, expect, it } from "vitest"
import { parseArgs } from "../src/util/args.js"

describe("CLI arguments", () => {
  it("accepts both spaced and equals-style flags", () => {
    const args = parseArgs(["crack", "LAW-1", "--runtime=fake", "--config", "demo.json", "--dry-run"])
    expect(args.command).toBe("crack")
    expect(args.positional).toEqual(["LAW-1"])
    expect(args.flags.get("runtime")).toBe("fake")
    expect(args.flags.get("config")).toBe("demo.json")
    expect(args.flags.get("dry-run")).toBe(true)
  })
})
