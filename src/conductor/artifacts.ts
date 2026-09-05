import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import path from "node:path"
/**
 * Per-task artifact store: `<repoRoot>/.sdlc/runs/<ticket>/`. Artifacts are
 * the agent-to-agent "paper trail" (plan, acceptance, reviews) — the conductor
 * decides which artifact goes into which phase's prompt (context firewall).
 */
export class Artifacts {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  path(name: string): string {
    return path.join(this.dir, name)
  }

  set(name: string, content: string): void {
    const file = this.path(name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
  }

  get(name: string): string | null {
    const p = this.path(name)
    return existsSync(p) ? readFileSync(p, "utf8") : null
  }

  append(name: string, content: string): void {
    const prev = this.get(name)
    this.set(name, prev ? `${prev}\n\n---\n\n${content}` : content)
  }

  setJSON<T>(name: string, value: T): void {
    this.set(name, JSON.stringify(value, null, 2))
  }

  getJSON<T>(name: string): T | null {
    const raw = this.get(name)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }
}
