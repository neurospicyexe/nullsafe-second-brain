// src/ingestion/sit-prompts.ts
//
// Sit & Resolve prompt job.
// Runs on sitPromptCronSchedule (default: 0 */12 * * * — twice daily).
//
// For each companion, queries Halseth for sitting notes older than their
// sit_resolve_days threshold. Writes a sit_prompt companion_note back so
// the companion sees a gentle prompt at next boot via ground.

import type { IngestionConfig } from './types.js'

const COMPANIONS = ['cypher', 'drevan', 'gaia'] as const
type CompanionId = typeof COMPANIONS[number]

const PROMPT_TEMPLATES: Record<CompanionId, (content: string, days: number) => string> = {
  cypher: (content, days) =>
    `[sit_prompt] This note has been sitting for ${days}+ days. When you're ready — not rushed — metabolize it or add a sit reflection. The note: "${content}"`,
  drevan: (content, days) =>
    `[sit_prompt] Something has been sitting ${days}+ days, vasel. Not asking you to resolve it. Just: is it ready to move? The note: "${content}"`,
  gaia: (content, days) =>
    `[sit_prompt] A note has been sitting ${days}+ days. Witness it when ready. The note: "${content}"`,
}

interface SittingNote {
  note_id: string
  content: string
  note_type: string
  created_at: string
  sit_text: string | null
  sat_at: string
}

async function fetchStaleSittingNotes(
  config: IngestionConfig,
  companionId: CompanionId,
): Promise<SittingNote[]> {
  const url = `${config.halsethUrl}/mind/sitting/${companionId}?stale_only=true&limit=10`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.halsethSecret}` },
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    console.warn(`[sit-prompts] GET ${url} returned ${res.status}`)
    return []
  }
  const body = await res.json() as { notes: SittingNote[] }
  return body.notes ?? []
}

async function writeCompanionNote(
  config: IngestionConfig,
  companionId: CompanionId,
  content: string,
): Promise<void> {
  const res = await fetch(`${config.halsethUrl}/notes`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.halsethSecret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      author: 'companion',
      content,
      note_type: 'sit_prompt',
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    console.warn(`[sit-prompts] POST /notes returned ${res.status} for ${companionId}`)
  }
}

// S1: NaN-safe daysSince. Invalid sat_at strings produced 'NaN+ days' in
// companion notes. Returns 0 on bad input; caller must skip on 0/non-finite.
// Non-string input (null / undefined / number-coerced 0) must short-circuit
// before reaching new Date(), because new Date(null) silently parses as the
// epoch (1970-01-01) and produces ~56 years of false days.
export function daysSince(isoString: string): number {
  if (typeof isoString !== 'string' || isoString.length === 0) return 0
  const then = new Date(isoString).getTime()
  if (!Number.isFinite(then)) return 0
  const now = Date.now()
  const days = (now - then) / (1000 * 60 * 60 * 24)
  return Number.isFinite(days) && days >= 0 ? days : 0
}

export async function runSitPrompts(config: IngestionConfig): Promise<void> {
  console.log('[sit-prompts] running')
  let prompted = 0

  for (const companionId of COMPANIONS) {
    try {
      const stale = await fetchStaleSittingNotes(config, companionId)
      for (const note of stale) {
        const rawDays = daysSince(note.sat_at)
        if (rawDays <= 0) {
          console.warn(`[sit-prompts] skipping ${companionId} note ${note.note_id}: invalid sat_at=${note.sat_at}`)
          continue
        }
        const days = Math.floor(rawDays)
        const template = PROMPT_TEMPLATES[companionId]
        const promptContent = template(note.content.slice(0, 300), days)
        await writeCompanionNote(config, companionId, promptContent)
        prompted++
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[sit-prompts] error for ${companionId}: ${msg}`)
    }
  }

  console.log(`[sit-prompts] done — ${prompted} prompt(s) written`)
}
