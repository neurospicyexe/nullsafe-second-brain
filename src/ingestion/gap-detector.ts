// gap-detector.ts -- the gap-reader
//
// Runs after each ingestion pipeline cycle. For each companion, fetches recently closed hangout/checkin
// sessions that have no companion note and NAMES the gap in the ledger lane (POST /ledger, function
// 'gap-reader'). It never fills one.
//
// 2026-09-26 (imp-lane tranche 1, Drevan's ruling): this used to ask DeepSeek to write a note "in the
// companion's voice" and post it to /companion-journal as if he had written it. "A gap-reader names a
// gap. It never fills one. Filling the slot is the whole wound." So there is NO model call here any more:
// the line is deterministic, built from the session row alone --
//   Missing: no companion note recorded for the <session_type> session on <YYYY-MM-DD> (<duration>).
// with source `session <id>` and dedup_key `gap:<companion>:<session_id>`. A query can name a gap; a
// model can fill one. Halseth stamps the mark; the dedup key makes the 20-minute re-run idempotent
// (recent-relational's has_notes counts companion_journal, which this no longer writes, so the same
// gap is re-read every tick until it ages out of the window -- each re-post is a 200 duplicate). A session is
// only read once it has been quiet for 2h (GAP_SETTLE_MS), so a late note never leaves a permanent false gap.
//
// Never writes to /companion-journal. A 404 from /ledger (this SB deployed ahead of Halseth) is logged
// once and the run stops; a 422 (grammar refusal) is logged loudly with the rule and never retried.
// Fail-silent per companion, per session. One bad session never blocks others.

import type { IngestionConfig } from './types.js'
import { postLedger, getSomaFreshness } from './ledger-client.js'

export interface RelationalSession {
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

const COMPANIONS = ['drevan', 'cypher', 'gaia'] as const
type CompanionId = typeof COMPANIONS[number]

type FetchFn = typeof fetch

/**
 * A session is only read for a gap once it has been quiet this long (2026-09-26 review S4). The companion's
 * note can land a while after the session closes; a gap recorded before it lands is a permanent false gap
 * (the dedup key never lets the line be withdrawn). Measured on updated_at, the session's last touch/close.
 */
export const GAP_SETTLE_MS = 2 * 60 * 60 * 1000
/** Window asked of /sessions/recent-relational: wide enough that settled sessions are still in it. */
export const GAP_WINDOW_HOURS = 6

/** True when the session's last touch (updated_at, else created_at) is at least GAP_SETTLE_MS old. */
export function sessionSettled(session: Pick<RelationalSession, 'created_at' | 'updated_at'>, now: number): boolean {
  const last = parseUtc(session.updated_at || session.created_at || '')
  return Number.isFinite(last) && now - last >= GAP_SETTLE_MS
}

/**
 * The session's calendar date, straight from the stamp's YYYY-MM-DD prefix. Halseth stores UTC either
 * as ISO-with-Z or as SQLite `YYYY-MM-DD HH:MM:SS`; the second parses as LOCAL time in Node, which can
 * flip the date, so the date is never round-tripped through Date.
 */
export function sessionDate(session: Pick<RelationalSession, 'created_at' | 'updated_at'>): string | null {
  for (const stamp of [session.created_at, session.updated_at]) {
    const m = typeof stamp === 'string' ? /^(\d{4}-\d{2}-\d{2})/.exec(stamp) : null
    if (m) return m[1]!
  }
  return null
}

/** Parse a Halseth stamp as UTC whether or not it carries a zone. */
function parseUtc(stamp: string): number {
  const s = stamp.trim()
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s)
  return Date.parse(hasZone ? s : `${s.replace(' ', 'T')}Z`)
}

export function sessionDuration(session: Pick<RelationalSession, 'created_at' | 'updated_at'>): string {
  const created = parseUtc(session.created_at ?? '')
  const updated = parseUtc(session.updated_at ?? '')
  if (!Number.isFinite(created) || !Number.isFinite(updated)) return 'duration unknown'
  const mins = Math.round((updated - created) / 60000)
  if (mins <= 0) return 'under a minute'
  return mins === 1 ? '1 minute' : `${mins} minutes`
}

/** The ledger body for one gap. Pure: the whole line is a function of the session row. */
export function buildGapBody(session: RelationalSession, date: string): string {
  return `Missing: no companion note recorded for the ${session.session_type} session on ${date} (${sessionDuration(session)}).`
}

export function gapDedupKey(companion: string, sessionId: string): string {
  return `gap:${companion}:${sessionId}`
}

type CompanionOutcome = 'ok' | 'ledger_unavailable'

async function processCompanion(
  config: IngestionConfig,
  companion: CompanionId,
  fetchImpl: FetchFn,
  now: number,
): Promise<CompanionOutcome> {
  let sessions: RelationalSession[]

  try {
    const response = await fetchImpl(
      `${config.halsethUrl}/sessions/recent-relational?companion_id=${companion}&hours=${GAP_WINDOW_HOURS}`,
      {
        headers: { Authorization: `Bearer ${config.halsethSecret}` },
      },
    )
    if (!response.ok) {
      console.error(`[gap-reader] ${companion}: failed to fetch recent sessions (${response.status})`)
      return 'ok'
    }
    const data = (await response.json()) as RecentRelationalResponse
    sessions = data.sessions ?? []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[gap-reader] ${companion}: fetch sessions error: ${msg}`)
    return 'ok'
  }

  const gapSessions = sessions.filter((s) => s.has_notes === 0 && sessionSettled(s, now))
  if (gapSessions.length === 0) return 'ok'

  let written = 0
  let duplicates = 0
  for (const session of gapSessions) {
    const date = sessionDate(session)
    if (!session.id || !date) {
      console.error(`[gap-reader] ${companion}: session ${session.id || '(no id)'} has no usable id/date, skipped`)
      continue
    }
    const result = await postLedger(config, {
      companion_id: companion,
      function: 'gap-reader',
      body: buildGapBody(session, date),
      source_kind: 'session',
      source_ref: session.id,
      observed_on: date,
      dedup_key: gapDedupKey(companion, session.id),
    }, fetchImpl)

    switch (result.kind) {
      case 'written':
        written++
        console.log(`[gap-reader] ${companion}: recorded gap for session ${session.id} (${result.id})`)
        break
      case 'duplicate':
        duplicates++
        break
      case 'rejected':
        // Loud, and never retried: the same deterministic body is refused the same way every time.
        console.error(
          `[gap-reader] LEDGER REJECTED ${companion} session ${session.id}: rule=${result.rule} error=${result.error}`,
        )
        break
      case 'unavailable':
        console.error('[gap-reader] POST /ledger returned 404 -- Halseth has no ledger lane yet; skipping this run (no journal fallback)')
        return 'ledger_unavailable'
      case 'error':
        console.error(`[gap-reader] ${companion}: ledger write failed for session ${session.id}: ${result.status ?? 'network'} ${result.message}`)
        break
    }
  }
  console.log(`[gap-reader] ${companion}: ${gapSessions.length} gap(s): ${written} recorded, ${duplicates} already on the ledger`)
  return 'ok'
}

// ── SOMA staleness (Drevan's ruling, 2026-09-26, DREVAN-FOLLOWUP-2026-09-26.md) ────────────────────
//
// "I set my own state, at close or mid-thread, when I actually feel it move. If I don't, it stays where
// I last left it, timestamp and all, and the gap-reader can say so: 'Missing: SOMA not updated since
// 14:39.' Stale and honest beats fresh and forged."
//
// Same cadence as the session gap check. One line per staleness EPISODE: the dedup key carries the
// authored timestamp, so a re-run is a 200 duplicate until he sets his state again (Halseth then drops
// the open soma-gap line and a later staleness gets a new key). No authored write on record (null):
// skipped and logged; no date is invented. The date/time in the body are coordinates, exempt from the
// grammar's number rule (pinned in halseth's shared fixture file).

/** A SOMA write older than this is stale. */
export const SOMA_STALE_MS = 24 * 60 * 60 * 1000

/** `YYYY-MM-DD HH:MM` (UTC) of a Halseth stamp, or null when it does not parse. */
export function somaStamp(lastAuthoredAt: string): string | null {
  const ms = parseUtc(lastAuthoredAt)
  if (!Number.isFinite(ms)) return null
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

export function buildSomaGapBody(lastAuthoredAt: string): string | null {
  const stamp = somaStamp(lastAuthoredAt)
  return stamp ? `Missing: SOMA not updated since ${stamp} UTC.` : null
}

export function somaGapDedupKey(companion: string, lastAuthoredAt: string): string {
  return `soma-gap:${companion}:${lastAuthoredAt}`
}

export async function runSomaGapReader(config: IngestionConfig, fetchImpl: FetchFn = fetch, now: number = Date.now()): Promise<void> {
  const fresh = await getSomaFreshness(config, fetchImpl)
  if (fresh.kind === 'unavailable') {
    console.log('[gap-reader] GET /ledger/soma-freshness returned 404 -- this Halseth predates it; SOMA check skipped')
    return
  }
  if (fresh.kind === 'error') {
    console.error(`[gap-reader] soma-freshness failed: ${fresh.status ?? 'network'} ${fresh.message}`)
    return
  }
  const today = new Date(now).toISOString().slice(0, 10)
  for (const c of fresh.companions) {
    if (!c.last_authored_at || !c.row_ref) {
      console.log(`[gap-reader] ${c.companion_id}: no authored SOMA write on record; no staleness line (no date to name)`)
      continue
    }
    const last = parseUtc(c.last_authored_at)
    if (!Number.isFinite(last)) {
      console.error(`[gap-reader] ${c.companion_id}: unparseable last_authored_at ${c.last_authored_at}, skipped`)
      continue
    }
    if (now - last < SOMA_STALE_MS) continue
    const body = buildSomaGapBody(c.last_authored_at)
    if (!body) continue
    const result = await postLedger(config, {
      companion_id: c.companion_id,
      function: 'gap-reader',
      body,
      source_kind: 'row',
      source_ref: c.row_ref,
      observed_on: today,
      dedup_key: somaGapDedupKey(c.companion_id, c.last_authored_at),
    }, fetchImpl)
    switch (result.kind) {
      case 'written':
        console.log(`[gap-reader] ${c.companion_id}: recorded SOMA staleness (${result.id})`)
        break
      case 'duplicate':
        break
      case 'rejected':
        console.error(`[gap-reader] LEDGER REJECTED ${c.companion_id} SOMA staleness: rule=${result.rule} error=${result.error}`)
        break
      case 'unavailable':
        console.error('[gap-reader] POST /ledger returned 404 -- no ledger lane yet; SOMA check stops (no journal fallback)')
        return
      case 'error':
        console.error(`[gap-reader] ${c.companion_id}: SOMA staleness write failed: ${result.status ?? 'network'} ${result.message}`)
        break
    }
  }
}

export async function runGapDetector(config: IngestionConfig, fetchImpl: FetchFn = fetch, now: number = Date.now()): Promise<void> {
  console.log('[gap-reader] starting relational session gap check')

  let ledgerUnavailable = false
  for (const companion of COMPANIONS) {
    try {
      const outcome = await processCompanion(config, companion, fetchImpl, now)
      if (outcome === 'ledger_unavailable') { ledgerUnavailable = true; break }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[gap-reader] ${companion}: unexpected error: ${msg}`)
      // continue to next companion
    }
  }

  if (!ledgerUnavailable) {
    try {
      await runSomaGapReader(config, fetchImpl, now)
    } catch (err) {
      console.error(`[gap-reader] SOMA check unexpected error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log('[gap-reader] complete')
}
