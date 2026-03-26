import type { IngestRecord, IngestionConfig, SourceType } from './types.js'

export interface PullerResult {
  records: IngestRecord[]
  error?: string
}

type PullFn = (config: IngestionConfig, since?: string) => Promise<PullerResult>

export const ALL_PULLERS: Array<{ source: SourceType; pull: PullFn }> = [
  { source: 'synthesis_summary', pull: pullSynthesisSummaries },
  { source: 'relational_delta', pull: pullRelationalDeltas },
  { source: 'feeling', pull: pullFeelings },
  { source: 'companion_journal', pull: pullCompanionJournal },
  { source: 'inter_companion_note', pull: pullInterCompanionNotes },
  { source: 'handoff', pull: pullHandoffs },
]

// Exported so tests can verify URL construction directly.
export function buildUrl(base: string, path: string, since?: string, limit = 100): string {
  const url = new URL(path, base)
  if (since) url.searchParams.set('since', since)
  url.searchParams.set('limit', String(limit))
  return url.toString()
}

function authHeaders(secret: string): HeadersInit {
  return { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }
}

// Halseth returns either a plain array or { items: [] }.
// Normalize both shapes to an array.
async function fetchRecords(url: string, secret: string): Promise<unknown[]> {
  const res = await fetch(url, {
    headers: authHeaders(secret),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Halseth fetch failed: ${res.status} ${res.statusText} ${url}`)
  }
  const data = await res.json() as unknown
  if (Array.isArray(data)) return data
  if (
    data !== null &&
    typeof data === 'object' &&
    'items' in data &&
    Array.isArray((data as Record<string, unknown>).items)
  ) {
    return (data as Record<string, unknown>).items as unknown[]
  }
  return []
}

// ---- per-source pull functions ----

interface RawSynthesisSummary {
  id: number
  companion_id: string
  summary_type: string
  content: string
  thread_key?: string
  created_at: string
}

export async function pullSynthesisSummaries(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/synthesis-summaries', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawSynthesisSummary[]).map((rec) => ({
      id: rec.id,
      source_type: 'synthesis_summary',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.companion_id,
      thread_key: rec.thread_key,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawRelationalDelta {
  id: number
  created_at: string
  agent: string
  delta_text: string
  valence?: string
  initiated_by?: string
}

export async function pullRelationalDeltas(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/deltas', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawRelationalDelta[]).map((rec) => ({
      id: rec.id,
      source_type: 'relational_delta',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.agent,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawFeeling {
  id: number
  created_at: string
  companion_id: string
  [key: string]: unknown
}

export async function pullFeelings(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/feelings', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawFeeling[]).map((rec) => ({
      id: rec.id,
      source_type: 'feeling',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawCompanionJournal {
  id: number
  created_at: string
  agent: string
  note_text: string
  [key: string]: unknown
}

export async function pullCompanionJournal(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/companion-journal', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawCompanionJournal[]).map((rec) => ({
      id: rec.id,
      source_type: 'companion_journal',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.agent,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawInterCompanionNote {
  id: number
  from_id: string
  to_id: string
  note_text: string
  tags?: string[]
  created_at: string
}

export async function pullInterCompanionNotes(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/inter-companion-notes', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawInterCompanionNote[]).map((rec) => ({
      id: rec.id,
      source_type: 'inter_companion_note',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.from_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawHandoff {
  id: number
  agent_id: string
  session_id: string
  handoff_text: string
  key_threads?: string[]
  mood_snapshot?: unknown
  created_at: string
}

export async function pullHandoffs(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/mind-handoffs', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawHandoff[]).map((rec) => ({
      id: rec.id,
      source_type: 'handoff',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.agent_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}
