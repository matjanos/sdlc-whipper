import { describe, expect, it } from "vitest"
import { parseSelector, resolveModel, discoverConfigPath, loadDotEnv } from "../src/config.js"
import { ConfigError } from "../src/config.js"

describe("selectors", () => {
  it("parses label and state selectors", () => {
    expect(parseSelector("label:sdlc-selected", "t")).toEqual({ kind: "label", name: "sdlc-selected" })
    expect(parseSelector("state:In Progress", "t")).toEqual({ kind: "state", name: "In Progress" })
  })
  it("rejects malformed selectors with context", () => {
    expect(() => parseSelector("sdlc-selected", "tracker.map.selected")).toThrow(ConfigError)
    expect(() => parseSelector("banana:sdlc", "tracker.map.selected")).toThrow(/label.*state/)
  })
})

describe("loadDotEnv", () => {
  it("does not override real env", () => {
    process.env["SDL_TEST_VAR"] = "real"
    loadDotEnv("test/fixtures/.env")
    expect(process.env["SDL_TEST_VAR"]).toBe("real")
  })
})

describe("model classes", () => {
  it("resolves agent model classes to concrete ids", async () => {
    const { loadConfig } = await import("../src/config.js")
    // config resolution against real repo layout is covered via temp repos elsewhere;
    // here we check the resolution logic contract directly
    const fakeConfig = {
      raw: {
        agents: { reviewer: { model: "reasoner" } },
        models: { reasoner: "prov/model#high" },
      },
    }
    expect(resolveModel(fakeConfig as never, "reviewer")).toBe("prov/model#high")
    expect(() => resolveModel({ raw: { agents: { reviewer: { model: "nope" } }, models: {} } } as never, "reviewer")).toThrow(
      /unknown model class/,
    )
  })
})

describe("discoverConfigPath", () => {
  it("errors helpfully when nothing is found", () => {
    expect(() => discoverConfigPath("/nonexistent/path/config.json")).toThrow(ConfigError)
  })
})
