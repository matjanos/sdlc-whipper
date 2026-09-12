import type { AgentRole } from "../../types.js"

export interface ModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface CatalogEntry {
  providerID: string
  id: string
  variants?: { id: string }[]
}

export interface ModelProblem {
  role: AgentRole
  ref: string
  detail: string
}

/** Parse `provider/id[#variant]` from a concrete model ref. */
export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/")
  if (slash <= 0) throw new Error(`opencode runtime: model ref "${ref}" must be provider/id`)
  const [providerID, rest] = [ref.slice(0, slash), ref.slice(slash + 1)]
  const hash = rest.indexOf("#")
  return hash > 0
    ? { providerID, id: rest.slice(0, hash), variant: rest.slice(hash + 1) }
    : { providerID, id: rest }
}

/** Tolerant `GET <service>/api/model` extraction — unwrap client envelopes ({data:[...]}) and tolerate already-array responses. */
export async function fetchCatalog(serviceUrl: string, headers?: Record<string, string>): Promise<CatalogEntry[]> {
  const res = await fetch(`${serviceUrl}/api/model`, { headers })
  if (!res.ok) throw new Error(`GET /api/model → ${res.status}`)
  const raw: unknown = await res.json()
  const list = (raw as Record<string, unknown>)?.data ?? raw
  return Array.isArray(list) ? (list as CatalogEntry[]) : []
}

/**
 * Validate role→model refs against the live server's catalog (`GET /api/model`,
 * entries `{ providerID, id, variants }`). Unknown models are accepted by
 * switchModel but hang the session until the polling window dies — this
 * converts that 10-minute silence into a one-second, actionable failure.
 */
export function invalidModelRefs(
  refs: { role: AgentRole; parsed: ModelRef }[],
  catalog: Iterable<CatalogEntry>,
): ModelProblem[] {
  const keys = new Set<string>()
  const ids = new Map<string, string[]>() // model id → providers offering it
  const variants = new Map<string, Set<string>>() // provider/id → variant ids
  for (const entry of catalog) {
    if (!entry?.providerID || !entry?.id) continue
    const key = `${entry.providerID}/${entry.id}`
    keys.add(key)
    ids.set(entry.id, [...(ids.get(entry.id) ?? []), entry.providerID])
    if (entry.variants?.length) {
      variants.set(key, new Set(entry.variants.map((v) => v?.id).filter((v): v is string => !!v)))
    }
  }

  const problems: ModelProblem[] = []
  for (const { role, parsed } of refs) {
    const key = `${parsed.providerID}/${parsed.id}`
    if (!keys.has(key)) {
      const providers = ids.get(parsed.id)
      const detail = providers?.length
        ? `unknown provider "${parsed.providerID}" for model "${parsed.id}" — available as ${providers.map((p) => `${p}/${parsed.id}`).join(", ")}`
        : `model "${key}" not in the server catalog`
      problems.push({ role, ref: key, detail })
      continue
    }
    const known = variants.get(key)
    if (parsed.variant && known && known.size > 0 && !known.has(parsed.variant)) {
      problems.push({
        role,
        ref: `${key}#${parsed.variant}`,
        detail: `unknown variant "${parsed.variant}" — available: ${[...known].join(", ")}`,
      })
    }
  }
  return problems
}
