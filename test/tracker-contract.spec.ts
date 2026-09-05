import { describe, expect, it } from "vitest"
import type { TicketTracker } from "../src/ports/index.js"
import { FakeTracker } from "../src/adapters/tracker-fake/index.js"
import type { Ticket } from "../src/types.js"

/**
 * The TicketTracker contract. Every adapter must pass this suite (run it
 * against Linear with LINEAR_API_KEY + LINEAR_TEST_TEAM, against the fake
 * always). This is what makes "swap Jira in" safe: the new adapter proves the
 * same behavior or it does not ship.
 */
export function trackerContract(name: string, make: () => Promise<TicketTracker>, opts: { teamKey?: string } = {}) {
  describe(`TicketTracker contract: ${name}`, () => {
    it("discovers a workspace and fails loudly on unknown mappings", async () => {
      const t = await make()
      const ws = await t.discoverWorkspace()
      expect(ws.teamKey).toBe(opts.teamKey ?? expect.any(String))
      expect(ws.stateIds["done"]).toBeTruthy()
    })

    it("create → get → comment → label → state → relation → sub-issue roundtrip", async () => {
      const t = await make()
      const created = await t.createIssue({ title: "Contract test ticket", description: "body" })
      expect(created.key).toBeTruthy()

      const fetched = await t.getTicket(created.key)
      expect(fetched.title).toBe("Contract test ticket")
      expect(fetched.state).toBe("backlog")

      await t.comment(created.key, "first comment <!-- marker-x -->")
      await t.comment(created.key, "first comment edited <!-- marker-x -->", { editExistingTag: "<!-- marker-x -->" })
      const afterComment = await t.getTicket(created.key)
      expect(afterComment.comments).toHaveLength(1)
      expect(afterComment.comments[0]!.body).toContain("edited")

      await t.addLabel(created.key, "sdlc-selected")
      expect((await t.getTicket(created.key)).labels).toContain("sdlc-selected")

      await t.moveTo(created.key, "inProgress")
      expect((await t.getTicket(created.key)).state).toBe("inProgress")

      const other = await t.createIssue({ title: "Blocker", description: "" })
      await t.setRelation(created.key, "blocked-by", other.key)
      const withRelation = await t.getTicket(created.key)
      expect(withRelation.relations.some((r) => r.kind === "blocked-by" && r.key === other.key)).toBe(true)

      const sub = await t.createSubIssue(created.key, { title: "Sub task", description: "split" })
      expect(sub.parentKey).toBe(created.key)
    })

    it("listIssues filters by logical label", async () => {
      const t = await make()
      const a = await t.createIssue({ title: "selected one", description: "" })
      // cover both concrete-naming conventions (fake: "selected", linear: "sdlc-selected")
      await t.addLabel(a.key, "selected")
      await t.addLabel(a.key, "sdlc-selected")
      const b = await t.createIssue({ title: "plain", description: "" })
      const selected = await t.listIssues({ logicalLabel: "selected" })
      const keys = selected.map((x: Ticket) => x.key)
      expect(keys).toContain(a.key)
      expect(keys).not.toContain(b.key)
    })

    it("getTicket throws on unknown key", async () => {
      const t = await make()
      await expect(t.getTicket("NOPE-404")).rejects.toThrow()
    })
  })
}

trackerContract("FakeTracker", () => Promise.resolve(new FakeTracker()), { teamKey: "FAKE" })
