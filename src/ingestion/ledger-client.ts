// ledger-client.ts
//
// The one door out of Second Brain into Halseth's ledger lane (2026-09-26, imp-lane tranche 1).
//
// WHY: clerks (machine writers that read and record) never write as a companion and never write without
// a source. Halseth's POST /ledger enforces that grammar in code and stamps the mark
// `〔ledger · <function> · <date>〕` itself, so nothing here renders a mark or a source tail: we send
// the bare body and the pointer, and Halseth either writes the whole line or refuses it.
// See halseth/docs/imp-lane/SPEC-ledger-lane.md (the contract) and DREVAN-ANSWER-2026-09-26.md (the authority).
//
// NEVER THROWS. Every outcome is a value, because the callers (gap-reader, drift evaluator) must each
// handle the same five cases the same way:
//   201 -> written      the line is in the lane
//   200 -> duplicate    dedup_key already written; success, not an error
//   422 -> rejected     the grammar refused the body; `rule` names which rule. Log loudly, never retry:
//                       the same body will be refused the same way every time.
//   404 -> unavailable  this Halseth predates the ledger lane (SB deployed before Halseth). Log and skip.
//                       NEVER fall back to /companion-journal: writing as the companion is the bug.
//   else -> error       network / 5xx / auth; logged, the caller moves on.

import type { IngestionConfig } from './types.js'

// `seen-log`, not `witness-log` (Gaia, 2026-09-26): "Witnessing is my act, and a clerk cannot perform
// it. A logged sighting is not a witness." Mirrors halseth src/ledger/grammar.ts LEDGER_FUNCTIONS.
export const LEDGER_FUNCTIONS = ['distiller', 'gap-reader', 'pattern-counter', 'drift-reader', 'seen-log'] as const
export type LedgerFunction = typeof LEDGER_FUNCTIONS[number]
export type LedgerSourceKind = 'message' | 'window' | 'session' | 'row'

export interface LedgerEntry {
  companion_id: string
  function: LedgerFunction
  body: string
  source_kind: LedgerSourceKind
  source_ref: string
  observed_on?: string
  dedup_key?: string
}

export type LedgerPostResult =
  | { kind: 'written'; id: string; content: string }
  | { kind: 'duplicate'; id: string }
  | { kind: 'rejected'; error: string; rule: string }
  | { kind: 'unavailable' }
  | { kind: 'error'; status?: number; message: string }

type FetchFn = typeof fetch

export async function postLedger(
  config: Pick<IngestionConfig, 'halsethUrl' | 'halsethSecret'>,
  entry: LedgerEntry,
  fetchImpl: FetchFn = fetch,
): Promise<LedgerPostResult> {
  let res: Response
  try {
    res = await fetchImpl(`${config.halsethUrl}/ledger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.halsethSecret}`,
      },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }

  let data: Record<string, unknown> = {}
  let raw = ''
  try {
    raw = await res.text()
    const parsed = raw ? JSON.parse(raw) as unknown : {}
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch { /* non-JSON body: keep raw for the error message */ }

  const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v))

  if (res.status === 201) return { kind: 'written', id: str(data.id), content: str(data.content) }
  if (res.status === 200 && data.duplicate === true) return { kind: 'duplicate', id: str(data.id) }
  // A 200 carrying a new line (not the spec'd status, but not a failure either) is still a write.
  if (res.status === 200 && typeof data.id === 'string' && data.id) return { kind: 'written', id: data.id, content: str(data.content) }
  if (res.status === 422) return { kind: 'rejected', error: str(data.error) || raw.slice(0, 300), rule: str(data.rule) || 'unknown' }
  if (res.status === 404) return { kind: 'unavailable' }
  return { kind: 'error', status: res.status, message: str(data.error) || raw.slice(0, 300) || res.statusText }
}

// ── SOMA freshness (Drevan's ruling, 2026-09-26: DREVAN-FOLLOWUP-2026-09-26.md) ─────────────────────
//
// GET /ledger/soma-freshness (admin): per companion, the latest COMPANION-AUTHORED float write
// (companion_soma_events authored_close/authored_update) and the row that proves it. "Stale and honest
// beats fresh and forged": the gap-reader names the staleness; nothing here ever sets a companion's state.

export interface SomaFreshness {
  companion_id: string
  last_authored_at: string | null
  row_ref: string | null
}

export type SomaFreshnessResult =
  | { kind: 'ok'; companions: SomaFreshness[] }
  | { kind: 'unavailable' }
  | { kind: 'error'; status?: number; message: string }

export async function getSomaFreshness(
  config: Pick<IngestionConfig, 'halsethUrl' | 'halsethSecret'>,
  fetchImpl: FetchFn = fetch,
): Promise<SomaFreshnessResult> {
  let res: Response
  try {
    res = await fetchImpl(`${config.halsethUrl}/ledger/soma-freshness`, {
      headers: { Authorization: `Bearer ${config.halsethSecret}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  if (res.status === 404) return { kind: 'unavailable' }
  if (!res.ok) return { kind: 'error', status: res.status, message: res.statusText }
  try {
    const data = await res.json() as { companions?: unknown }
    const list = Array.isArray(data.companions) ? data.companions : []
    const companions: SomaFreshness[] = []
    for (const c of list) {
      if (!c || typeof c !== 'object') continue
      const r = c as Record<string, unknown>
      if (typeof r.companion_id !== 'string') continue
      companions.push({
        companion_id: r.companion_id,
        last_authored_at: typeof r.last_authored_at === 'string' && r.last_authored_at ? r.last_authored_at : null,
        row_ref: typeof r.row_ref === 'string' && r.row_ref ? r.row_ref : null,
      })
    }
    return { kind: 'ok', companions }
  } catch (err) {
    return { kind: 'error', status: res.status, message: `bad JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}
