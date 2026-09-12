import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"

const dir = mkdtempSync(path.join(tmpdir(), "sdlc-probe3-"))
mkdirSync(path.join(dir, ".opencode"), { recursive: true })
writeFileSync(path.join(dir, ".opencode", "opencode.json"), JSON.stringify({
  agents: { "sdlc-researcher": {
    description: "researcher probe", mode: "primary",
    system: "You complete tasks.", permissions: [],
    model: "zai-coding-plan/glm-5.3-flash",
  } },
}, null, 2))

const endpoint = await Service.ensure()
const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })

// EXACTLY what the runtime does: event subscription running concurrently
const consumed = (async () => {
  let n = 0
  try {
    for await (const e of client.event.subscribe()) {
      n++
      await new Promise(r => setTimeout(r, 25)) // simulate ledger write
    }
  } catch (e) { console.log("event loop ended:", String(e).slice(0, 100)) }
  return n
})()

const s = await client.session.create({ location: { directory: dir }, title: "sdlc:DEBUG:evprobe" })
const sid = s.id ?? s.data?.id
await client.session.switchAgent({ sessionID: sid, agent: "sdlc-researcher" })
await client.session.switchModel({ sessionID: sid, model: { providerID: "zai-coding-plan", id: "glm-5.3-flash" } })
try {
  await client.session.prompt({ sessionID: sid, text: "Reply with exactly: SMOKE-OK" })
  await client.session.wait?.({ sessionID: sid }).catch(() => {})
  console.log("prompt+wait: ok")
} catch (e) { console.log("prompt threw:", String(e).slice(0, 160)) }
await new Promise(r => setTimeout(r, 3000))
const ctx = await client.session.context({ sessionID: sid }).catch(() => null)
const raw = JSON.stringify(ctx ?? {})
console.log(raw.includes("SMOKE-OK") ? "RESULT: SMOKE-OK ✓ (subscription present)" : "RESULT: failed — " + (raw.match(/provider\.[a-z-]+|AI\.Error[^"]*/)?.[0]?.slice(0, 140) ?? raw.slice(0, 200)))
