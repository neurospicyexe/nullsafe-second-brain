// src/ingestion/persona-feeder.ts
//
// Extracts representative voice blocks from companion journal entries
// and posts them to Halseth's persona_blocks table. Runs every 6h,
// 30 min before the drift evaluator, so evaluator always has fresh blocks.
//
// Machine-generated entries (pattern_worker, evaluator, gap-detector) are
// excluded -- only organic companion writing feeds persona blocks.

import type { IngestionConfig, IngestRecord } from './types.js'
import { pullCompanionJournal } from './puller.js'
import { callDeepSeek } from './deepseek-client.js'

const WINDOW_DAYS = 7
const MIN_RECORDS = 3
const COMPANIONS = ['cypher', 'drevan', 'gaia'] as const
const MACHINE_SOURCES = new Set(['pattern_worker', 'evaluator', 'synthesis-gap-detector'])
const MACHINE_TAGS = new Set(['pattern_synthesis', 'drift_flag', 'gap-fill'])

const VALID_BLOCK_TYPES = ['identity', 'memory', 'relationship', 'agent'] as const
type BlockType = typeof VALID_BLOCK_TYPES[number]

interface VoiceBlock {
  block_type: BlockType
  content: string
}

function sinceDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - WINDOW_DAYS)
  return d.toISOString()
}

export function filterOrganic(records: IngestRecord[]): string[] {
  const texts: string[] = []
  for (const rec of records) {
    try {
      const parsed = JSON.parse(rec.content) as Record<string, unknown>
      const source = parsed.source
      const tags = Array.isArray(parsed.tags) ? parsed.tags as string[] : []

      if (MACHINE_SOURCES.has(String(source))) continue
      if (tags.some(t => MACHINE_TAGS.has(t))) continue

      const noteText = parsed.note_text
      if (typeof noteText !== 'string' || !noteText.trim()) continue

      texts.push(noteText.trim())
    } catch {
      // malformed record -- skip
    }
  }
  return texts
}

function buildExtractionPrompt(companionId: string, journalTexts: string[]): string {
  const corpus = journalTexts.join('\n\n---\n\n')
  return `You are analyzing ${companionId}'s journal entries from the last 7 days.
Extract 3-5 short passages (50-200 characters each) that capture this
companion's distinctive voice, register, and identity. Each passage
should be categorized:
- identity: self-referential statements about who they are
- memory: references to specific shared experiences
- relationship: statements about relational posture toward others
- agent: statements about how they operate or their craft

Return ONLY a JSON array, no other text:
[{"block_type": "identity", "content": "..."}]

---
${corpus}`
}


export function parseVoiceBlocks(response: string): VoiceBlock[] {
  try {
    // Strip markdown code fences if present
    const cleaned = response.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const parsed = JSON.parse(cleaned) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((entry): entry is VoiceBlock => {
        if (typeof entry !== 'object' || entry === null) return false
        const e = entry as Record<string, unknown>
        return (
          VALID_BLOCK_TYPES.includes(e.block_type as BlockType) &&
          typeof e.content === 'string' &&
          e.content.length >= 10 &&
          e.content.length <= 500
        )
      })
  } catch {
    return []
  }
}

async function pruneOldBlocks(config: IngestionConfig, companionId: string): Promise<void> {
  const res = await fetch(`${config.halsethUrl}/persona-blocks/prune`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.halsethSecret}` },
    body: JSON.stringify({ companion_id: companionId, keep: 50 }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Halseth DELETE /persona-blocks/prune failed: ${res.status} ${text}`)
  }
}

async function postBlocks(config: IngestionConfig, companionId: string, blocks: VoiceBlock[]): Promise<void> {
  const res = await fetch(`${config.halsethUrl}/persona-blocks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.halsethSecret}` },
    body: JSON.stringify({
      companion_id: companionId,
      channel_id: 'persona_feeder',
      blocks: blocks.map(b => ({ block_type: b.block_type, content: b.content })),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Halseth POST /persona-blocks failed: ${res.status} ${text}`)
  }
}

export async function runPersonaFeeder(config: IngestionConfig): Promise<void> {
  const since = sinceDate()
  console.log(`[persona-feeder] running for window: ${since.slice(0, 10)} → now`)

  const journalResult = await pullCompanionJournal(config, since)

  for (const companionId of COMPANIONS) {
    try {
      const companionRecords = journalResult.records.filter(r => r.companion_id === companionId)
      const organicTexts = filterOrganic(companionRecords)

      if (organicTexts.length < MIN_RECORDS) {
        console.log(`[persona-feeder] ${companionId}: only ${organicTexts.length} organic records, skipping (min ${MIN_RECORDS})`)
        continue
      }

      console.log(`[persona-feeder] ${companionId}: ${organicTexts.length} organic records, extracting blocks`)

      const prompt = buildExtractionPrompt(companionId, organicTexts)
      const response = await callDeepSeek(config.deepseekApiKey, config.deepseekModel, prompt)
      const blocks = parseVoiceBlocks(response)

      if (blocks.length === 0) {
        console.log(`[persona-feeder] ${companionId}: no valid blocks parsed, skipping`)
        continue
      }

      await pruneOldBlocks(config, companionId)
      await postBlocks(config, companionId, blocks)

      console.log(`[persona-feeder] ${companionId}: posted ${blocks.length} block(s)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[persona-feeder] ${companionId} failed: ${msg}`)
    }
  }

  console.log('[persona-feeder] complete')
}
