import type { IngestRecord, IngestionConfig, SourceType } from './types.js'

export interface PullerResult {
  records: IngestRecord[]
  error?: string
}

type PullFn = (config: IngestionConfig, since?: string) => Promise<PullerResult>

// isUpdate: if true, pipeline deletes the existing vector entry before re-indexing
// instead of skipping duplicates. Used for sources where records mutate after creation.
export const ALL_PULLERS: Array<{ source: string; pull: PullFn; isUpdate?: boolean }> = [
  { source: 'synthesis_summary', pull: pullSynthesisSummaries },
  { source: 'relational_delta', pull: pullRelationalDeltas },
  { source: 'feeling', pull: pullFeelings },
  { source: 'companion_journal', pull: pullCompanionJournal },
  { source: 'inter_companion_note', pull: pullInterCompanionNotes },
  { source: 'handoff', pull: pullHandoffs },
  { source: 'wound', pull: pullWounds },
  { source: 'companion_dream', pull: pullCompanionDreams },
  { source: 'open_loop', pull: pullOpenLoops },
  { source: 'open_loop_closure', pull: pullClosedOpenLoops, isUpdate: true },
  { source: 'relational_state', pull: pullRelationalState },
  { source: 'tension', pull: pullTensions },
  { source: 'tension_update', pull: pullTensionUpdates, isUpdate: true },
  { source: 'growth_journal', pull: pullGrowthJournal },
  { source: 'companion_conclusion', pull: pullCompanionConclusions },
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
  subject?: string
  narrative?: string
  emotional_register?: string
  open_threads?: string
  drevan_state?: string
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
  to_id: string | null
  content: string
  read_at: string | null
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
  thread_id: string | null
  title: string
  summary: string
  next_steps: string | null
  open_loops: string | null
  state_hint: string | null
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

// ── Growth layer (migration 0045) ────────────────────────────────────────────

interface RawGrowthJournal {
  id: string
  companion_id: string
  entry_type: string
  content: string
  source: string
  tags_json: string
  created_at: string
}

export async function pullGrowthJournal(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/growth-journal', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawGrowthJournal[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'growth_journal',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawCompanionConclusion {
  id: string
  companion_id: string
  conclusion_text: string
  source_sessions: string | null
  superseded_by: string | null
  created_at: string
}

export async function pullCompanionConclusions(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/companion-conclusions', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawCompanionConclusion[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'companion_conclusion',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

// ── New surfaces (migrations 0028–0030) ──────────────────────────────────────

interface RawWound {
  id: string
  name: string
  description: string
  last_visited: string | null
  last_surfaced_by: string | null
  created_at: string
}

export async function pullWounds(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/wounds', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawWound[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'wound',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      // wounds are cross-companion (no companion_id)
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawCompanionDream {
  id: string
  companion_id: string
  dream_text: string
  source: string
  examined: number
  examined_at: string | null
  created_at: string
}

export async function pullCompanionDreams(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/companion-dreams', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawCompanionDream[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'companion_dream',
      content: JSON.stringify(rec),
      created_at: rec.created_at,
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawOpenLoop {
  id: string
  companion_id: string
  loop_text: string
  weight: number
  opened_at: string
  closed_at: string | null
}

export async function pullOpenLoops(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/open-loops', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawOpenLoop[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'open_loop',
      content: JSON.stringify(rec),
      created_at: rec.opened_at,   // opened_at is the canonical timestamp
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

// Sweeps for loop closures using closed_at as the HWM.
// Returns source_type 'open_loop' so the pipeline overwrites the stale vector entry.
export async function pullClosedOpenLoops(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = new URL('/ingest/open-loops', config.halsethUrl)
    // Always send closed_since (epoch on first run) to force closed_at ASC ordering
    // and server-side null filter, so the HWM advances correctly from the start.
    url.searchParams.set('closed_since', since ?? '1970-01-01T00:00:00.000Z')
    url.searchParams.set('limit', '100')
    const raw = await fetchRecords(url.toString(), config.halsethSecret)
    const records: IngestRecord[] = (raw as RawOpenLoop[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'open_loop',
      content: JSON.stringify(rec),
      created_at: rec.closed_at!,  // HWM tracks closed_at for this sweep
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawRelationalState {
  id: string
  companion_id: string
  toward: string
  state_text: string
  weight: number
  state_type: string
  noted_at: string
}

export async function pullRelationalState(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/relational-state', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawRelationalState[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'relational_state',
      content: JSON.stringify(rec),
      created_at: rec.noted_at,    // noted_at is the canonical timestamp
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

interface RawTension {
  id: string
  companion_id: string
  tension_text: string
  status: string
  first_noted_at: string
  last_surfaced_at: string | null
  notes: string | null
}

export async function pullTensions(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = buildUrl(config.halsethUrl, '/ingest/tensions', since)
    const raw = await fetchRecords(url, config.halsethSecret)
    const records: IngestRecord[] = (raw as RawTension[]).map((rec) => ({
      id: rec.id as unknown as number,
      source_type: 'tension',
      content: JSON.stringify(rec),
      created_at: rec.first_noted_at,  // first_noted_at is the canonical timestamp
      companion_id: rec.companion_id,
    }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}

// Sweeps for status changes on existing tensions using last_surfaced_at as the HWM.
// Returns the same source_type ('tension') so the pipeline overwrites the stale vector entry.
export async function pullTensionUpdates(
  config: IngestionConfig,
  since?: string,
): Promise<PullerResult> {
  try {
    const url = new URL('/ingest/tensions', config.halsethUrl)
    // Always send updated_since (epoch on first run) to force last_surfaced_at ASC ordering
    // and server-side null filter, so the HWM advances correctly from the start.
    url.searchParams.set('updated_since', since ?? '1970-01-01T00:00:00.000Z')
    url.searchParams.set('limit', '100')
    const raw = await fetchRecords(url.toString(), config.halsethSecret)
    const records: IngestRecord[] = (raw as RawTension[]).map((rec) => ({
        id: rec.id as unknown as number,
        source_type: 'tension',
        content: JSON.stringify(rec),
        created_at: rec.last_surfaced_at!,  // HWM tracks last_surfaced_at for this sweep
        companion_id: rec.companion_id,
      }))
    return { records }
  } catch (e) {
    return { records: [], error: (e as Error).message }
  }
}
