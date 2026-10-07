// src/ingestion/household-grounding.ts
//
// 2026-10-07: Drevan's Claude.ai orient carried two [Vault excerpts] calling Lucy -- Raziel's
// Dalmatian -- a "sick cat". Neither source row said "cat": the word was invented by wrapChunk's
// contextual preamble (deepseek-wrapper.ts), which saw "Lucy is sick" with no species and guessed.
// The household has cats AND dogs, so a guess is wrong often enough to matter, and a preamble is
// embedded in front of the record, so the guess becomes what semantic search returns.
//
// Fix: ground the preamble writer in the canonical record -- Halseth `architect_facts`,
// category 'animals', status 'active' (GET /identity/architect-facts, same auth as every puller) --
// plus a rule that applies even when that fetch fails: never infer species/kind/relationship.
//
// The facts are fetched at most once per TTL (the ingestion tick wraps many records), and the fetch
// fails OPEN: no facts -> the rule still rides, the wrap still happens. Ingestion never stalls on it.

import { authHeaders } from './puller.js'

export const HOUSEHOLD_GROUNDING_RULE =
  'GROUNDING (hard rule; apply it silently, never restate it): state only what the content states. ' +
  'Do not infer the species, breed, kind, relationship or role of any named person or animal. ' +
  'When an animal is named, use the HOUSEHOLD ANIMALS record below if it lists that name; ' +
  'if the name is not in the record, refer to it by name only, without classifying it.'

export const HOUSEHOLD_FACTS_TTL_MS = 60 * 60 * 1000

interface FactRow {
  fact?: unknown
  category?: unknown
  status?: unknown
}

export interface HouseholdGroundingConfig {
  halsethUrl?: string
  halsethSecret?: string
}

let cache: { facts: string[]; at: number } | null = null
let warnedFetch = false

/** Test hook: drop the cached facts and re-arm the once-per-process fetch warning. */
export function resetHouseholdFactsCache(): void {
  cache = null
  warnedFetch = false
}

/**
 * The active `animals` facts from Halseth, cached for HOUSEHOLD_FACTS_TTL_MS. `open` rows are
 * questions, not facts, and are excluded. Returns [] (and logs once) when Halseth is unreachable;
 * a failed fetch is not cached, so the next wrap retries.
 */
export async function fetchHouseholdFacts(
  config: HouseholdGroundingConfig,
  now: number = Date.now(),
): Promise<string[]> {
  if (!config.halsethUrl) return []
  if (cache && now - cache.at < HOUSEHOLD_FACTS_TTL_MS) return cache.facts
  try {
    const url = new URL('/identity/architect-facts', config.halsethUrl).toString()
    const res = await fetch(url, {
      headers: authHeaders(config.halsethSecret ?? ''),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { facts?: FactRow[] }
    const facts = (Array.isArray(data?.facts) ? data.facts : [])
      .filter(r => r.category === 'animals' && r.status === 'active' && typeof r.fact === 'string')
      .map(r => (r.fact as string).trim())
      .filter(f => f.length > 0)
    cache = { facts, at: now }
    return facts
  } catch (e) {
    if (!warnedFetch) {
      warnedFetch = true
      console.warn(`[household-grounding] architect-facts fetch failed (${(e as Error).message}); wrapping with the rule only`)
    }
    return []
  }
}

/** The system-prompt text: the rule, then the canonical animals record when there is one. */
export function householdGroundingBlock(facts: string[]): string {
  if (facts.length === 0) return HOUSEHOLD_GROUNDING_RULE
  return `${HOUSEHOLD_GROUNDING_RULE}\n\nHOUSEHOLD ANIMALS (canonical record):\n${facts.map(f => `- ${f}`).join('\n')}`
}
