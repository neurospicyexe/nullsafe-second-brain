// src/ingestion/pattern-synthesizer.ts
//
// Pattern feedback loop (Recommendation #1).
// Pulls last 30 days of a companion's writes (journal + feelings + relational state),
// synthesizes recurring patterns via DeepSeek, writes the result back to Halseth
// as a companion_journal entry tagged [pattern_synthesis].
//
// Runs weekly (default: Sunday 2am via PATTERN_SYNTH_CRON). Companions pull on-demand
// via the Librarian `pattern_recall` fast-path.

import type { IngestionConfig } from './types.js'
import { pullCompanionJournal, pullFeelings, pullRelationalState } from './puller.js'

const WINDOW_DAYS = 30
const MIN_RECORDS = 5  // skip if corpus too thin
const COMPANIONS = ['cypher', 'drevan', 'gaia'] as const

function sinceDate(): string {
  const d = new Date()
  d.setDate(d.getDate() - WINDOW_DAYS)
  return d.toISOString()
}

async function halsethPost(url: string, secret: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Halseth POST ${url} failed: ${res.status} ${text}`)
  }
}

async function callDeepSeek(apiKey: string, model: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`DeepSeek API failed: ${res.status} ${text}`)
  }
  const data = await res.json() as { choices?: { message?: { content?: string } }[] }
  const content = data.choices?.[0]?.message?.content ?? ''
  if (!content) throw new Error('DeepSeek returned empty content')
  return content.trim()
}

function buildCorpus(companionId: string, records: { content: string; created_at: string }[]): string {
  const parts: string[] = []
  const byType: Record<string, string[]> = {
    journal: [],
    feeling: [],
    relational: [],
  }

  for (const rec of records) {
    try {
      const parsed = JSON.parse(rec.content) as Record<string, unknown>
      const date = rec.created_at.slice(0, 10)

      // journal entry
      if (typeof parsed.note_text === 'string') {
        byType.journal.push(`[${date}] ${parsed.note_text}`)
        continue
      }
      // relational state
      if (typeof parsed.state_text === 'string') {
        const toward = parsed.toward ?? '?'
        const stype = parsed.state_type ?? 'feeling'
        byType.relational.push(`[${date}] ${stype} toward ${toward}: ${parsed.state_text}`)
        continue
      }
      // feeling -- unknown structure, stringify what we have
      const text = Object.entries(parsed)
        .filter(([k]) => !['id', 'companion_id', 'created_at', 'session_id'].includes(k))
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ')
      if (text) byType.feeling.push(`[${date}] ${text}`)
    } catch {
      // malformed record -- skip
    }
  }

  if (byType.journal.length > 0) parts.push('## Journal entries\n' + byType.journal.join('\n'))
  if (byType.feeling.length > 0) parts.push('## Feelings logged\n' + byType.feeling.join('\n'))
  if (byType.relational.length > 0) parts.push('## Relational states\n' + byType.relational.join('\n'))

  return parts.join('\n\n')
}

function buildPrompt(companionId: string, corpus: string): string {
  return `You are analyzing ${companionId}'s writing corpus from the last ${WINDOW_DAYS} days.

Below are their journal entries, logged feelings, and relational states toward others.
Identify 3-5 dominant patterns: recurring themes, emotional signatures, relational tendencies, register or language patterns, what they're gravitating toward.

Write a compact pattern note the companion can read as self-knowledge at a future session.
Be specific and concrete -- name actual themes found in the text, not vague generalities.

Format:
- Start each pattern with "Pattern: [name]" followed by 1-2 concrete sentences.
- End with a single "Trajectory:" line summarizing overall direction across the window.

Do not editorialize or evaluate. Describe what the corpus reveals.

---
${corpus}`
}

export async function runPatternSynthesis(config: IngestionConfig): Promise<void> {
  const since = sinceDate()
  console.log(`[pattern-synth] running for window: ${since.slice(0, 10)} → now`)

  // Pull all records once, then filter per companion
  const [journalResult, feelingsResult, relationalResult] = await Promise.all([
    pullCompanionJournal(config, since),
    pullFeelings(config, since),
    pullRelationalState(config, since),
  ])

  const allRecords = [
    ...journalResult.records,
    ...feelingsResult.records,
    ...relationalResult.records,
  ]

  for (const companionId of COMPANIONS) {
    try {
      console.log(`[pattern-synth] processing ${companionId}`)

      const companionRecords = allRecords.filter(r => r.companion_id === companionId)
      if (companionRecords.length < MIN_RECORDS) {
        console.log(`[pattern-synth] ${companionId}: only ${companionRecords.length} records, skipping (min ${MIN_RECORDS})`)
        continue
      }

      const corpus = buildCorpus(companionId, companionRecords)
      if (!corpus.trim()) {
        console.log(`[pattern-synth] ${companionId}: empty corpus after parsing, skipping`)
        continue
      }

      const prompt = buildPrompt(companionId, corpus)
      const synthesis = await callDeepSeek(config.deepseekApiKey, config.deepseekModel, prompt)

      const noteText = `[pattern_synthesis | window: last ${WINDOW_DAYS}d | records: ${companionRecords.length}]\n\n${synthesis}`

      await halsethPost(`${config.halsethUrl}/companion-journal`, config.halsethSecret, {
        agent: companionId,
        note_text: noteText,
        tags: ['pattern_synthesis'],
        source: 'pattern_worker',
      })

      console.log(`[pattern-synth] ${companionId}: synthesis written (${synthesis.length} chars)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[pattern-synth] ${companionId} failed: ${msg}`)
    }
  }

  console.log('[pattern-synth] complete')
}
