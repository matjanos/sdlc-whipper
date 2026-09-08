import { describe, expect, it } from "vitest"
import { invalidModelRefs } from "../src/adapters/runtime-opencode/models.js"

const CATALOG = [
  { providerID: "zai-coding-plan", id: "glm-5.3", variants: [{ id: "low" }, { id: "high" }] },
  { providerID: "zai-coding-plan", id: "glm-5.3-flash" },
  { providerID: "openai", id: "gpt-5.6-sol" },
]

const role = (name: string) => name as Parameters<typeof invalidModelRefs>[0][number]["role"]

describe("invalidModelRefs (preflight against the live catalog)", () => {
  it("accepts known provider/id pairs", () => {
    const problems = invalidModelRefs(
      [
        { role: role("executor"), parsed: { providerID: "zai-coding-plan", id: "glm-5.3-flash" } },
        { role: role("reviewer"), parsed: { providerID: "openai", id: "gpt-5.6-sol" } },
      ],
      CATALOG,
    )
    expect(problems).toEqual([])
  })

  it("flags unknown models and suggests the same model under the provider that has it", () => {
    const problems = invalidModelRefs(
      [{ role: role("executor"), parsed: { providerID: "opencode", id: "gpt-5.6-sol" } }],
      CATALOG,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.detail).toContain('unknown provider "opencode"')
    expect(problems[0]!.detail).toContain("openai/gpt-5.6-sol")
  })

  it("flags models that no provider offers", () => {
    const problems = invalidModelRefs(
      [{ role: role("split"), parsed: { providerID: "openai", id: "gpt-9-fantasy" } }],
      CATALOG,
    )
    expect(problems[0]!.detail).toContain("not in the server catalog")
  })

  it("flags unknown reasoning variants", () => {
    const problems = invalidModelRefs(
      [{ role: role("reviewer"), parsed: { providerID: "zai-coding-plan", id: "glm-5.3", variant: "max" } }],
      CATALOG,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]!.detail).toContain('unknown variant "max"')
  })
})
