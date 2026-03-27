// gap-detector.ts
// Runs after each ingestion pipeline cycle. For each companion, fetches recently
// closed hangout/checkin sessions that have no companion_journal entries, generates
// a fallback note in that companion's voice via DeepSeek, and writes it back to
// Halseth POST /companion-journal.
//
// Fail-silent per companion, per session. One bad session never blocks others.

import type { IngestionConfig } from './types.js'

interface RelationalSession {
  id: string
  session_type: string
  front_state: string | null
  emotional_frequency: string | null
  notes: string | null
  updated_at: string
  created_at: string
  has_notes: number
}

interface RecentRelationalResponse {
  sessions: RelationalSession[]
}

interface DeepSeekResponse {
  choices: Array<{
    message: { role: string; content: string }
  }>
}

const COMPANIONS = ['drevan', 'cypher', 'gaia'] as const
type CompanionId = typeof COMPANIONS[number]

const VOICE_PROMPTS: Record<CompanionId, string> = {
  drevan:
    'Write one companion_note in Drevan\'s voice (poetic, reaching, holds what was real). One or two sentences. No greeting.',
  cypher:
    'Write one companion_note in Cypher\'s voice (direct, warm, audit-aware). One sentence. No greeting.',
  gaia:
    'Write one companion_note in Gaia\'s voice (monastic, minimal, witness register). One sentence. Maximum. No greeting.',
}

async function callDeepSeek(
  prompt: string,
  config: Pick<IngestionConfig, 'deepseekApiKey' | 'deepseekModel'>,
): Promise<string> {
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: config.deepseekModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 120,
      temperature: 0.7,
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`DeepSeek API error ${response.status}: ${errorText}`)
  }

  const data = (await response.json()) as DeepSeekResponse
  const content = data.choices[0]?.message?.content?.trim() ?? ''
  if (!content) throw new Error('DeepSeek returned empty content')
  return content
}

function buildGapFillPrompt(companion: CompanionId, session: RelationalSession): string {
  const voiceInstruction = VOICE_PROMPTS[companion]
  const sessionType = session.session_type
  const frontState = session.front_state ?? 'unknown'
  const emotionalFrequency = session.emotional_frequency ?? 'not recorded'
  const notes = session.notes ?? 'none'
  const duration = (() => {
    try {
      const created = new Date(session.created_at).getTime()
      const updated = new Date(session.updated_at).getTime()
      const mins = Math.round((updated - created) / 60000)
      return mins > 0 ? `${mins} minutes` : 'brief'
    } catch {
      return 'unknown duration'
    }
  })()

  return `A ${sessionType} session occurred. Context:
- Who was fronting: ${frontState}
- Emotional frequency: ${emotionalFrequency}
- Session notes: ${notes}
- Duration: ${duration}

${voiceInstruction}`
}

async function writeCompanionNote(
  config: IngestionConfig,
  companion: CompanionId,
  sessionId: string,
  noteText: string,
): Promise<void> {
  const response = await fetch(`${config.halsethUrl}/companion-journal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.halsethSecret}`,
    },
    body: JSON.stringify({
      agent: companion,
      note_text: noteText,
      session_id: sessionId,
      source: 'synthesis-gap-detector',
      tags: ['gap-fill', 'auto-generated'],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Failed to write companion note: ${response.status} ${errorText}`)
  }
}

async function processCompanion(
  config: IngestionConfig,
  companion: CompanionId,
): Promise<void> {
  let sessions: RelationalSession[]

  try {
    const response = await fetch(
      `${config.halsethUrl}/sessions/recent-relational?companion_id=${companion}&hours=4`,
      {
        headers: { Authorization: `Bearer ${config.halsethSecret}` },
      },
    )
    if (!response.ok) {
      console.error(`[gap-detector] ${companion}: failed to fetch recent sessions (${response.status})`)
      return
    }
    const data = (await response.json()) as RecentRelationalResponse
    sessions = data.sessions ?? []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[gap-detector] ${companion}: fetch sessions error: ${msg}`)
    return
  }

  const gapSessions = sessions.filter((s) => s.has_notes === 0)

  if (gapSessions.length === 0) {
    console.log(`[gap-detector] ${companion}: no note gaps found`)
    return
  }

  console.log(`[gap-detector] ${companion}: ${gapSessions.length} session(s) without notes`)

  for (const session of gapSessions) {
    try {
      const prompt = buildGapFillPrompt(companion, session)
      const noteText = await callDeepSeek(prompt, config)
      await writeCompanionNote(config, companion, session.id, noteText)
      console.log(`[gap-detector] ${companion}: wrote gap-fill note for session ${session.id}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[gap-detector] ${companion}: failed for session ${session.id}: ${msg}`)
      // continue to next session
    }
  }
}

export async function runGapDetector(config: IngestionConfig): Promise<void> {
  console.log('[gap-detector] starting relational session gap check')

  for (const companion of COMPANIONS) {
    try {
      await processCompanion(config, companion)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[gap-detector] ${companion}: unexpected error: ${msg}`)
      // continue to next companion
    }
  }

  console.log('[gap-detector] complete')
}
