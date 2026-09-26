// Recall reconcile (2026-09-26): delete the rag/ mirrors of journal rows that are no longer memory.
//
// WHY: the puller mirrors companion_journal rows as rag/companion_journal/<id> (each wrapped in a
// book report). Halseth mig 0132 then put review_state on the table and backfilled ~600 rows to
// draft; reviews since have dropped more, and retractions / releases / the salience prune archive
// rows. The journal feed is kept-only, so a mirror pulled BEFORE any of that can never correct
// itself -- nothing ever re-serves the row. On 2026-09-26 such mirrors ranked TOP in recall and
// resurfaced a fabrication. Measured the same day: 2038 of 5392 journal mirrors were of rows that
// are not memory (510 draft, 64 dropped, 1464 archived).
//
// HOW: page Halseth's GET /ingest/recall-ineligible and delete each listed id's mirror through
// retractPath (the SAME delete POST /retract uses: rows + ANN vectors + FTS via trigger).
//   - INCREMENTAL on every ingestion tick, from its own mark `recall_ineligible_journal` in the hwm
//     store: catches drafts, drops and anything whose review cursor moved since the last pass.
//   - FULL when the mark is absent, at startup, and every RECALL_RECONCILE_FULL_MINUTES (default 60):
//     an archive stamps no time in Halseth, so a row archived long after its cursor is only visible
//     to a full sweep. The full sweep costs about the same D1 rows as one incremental page (keyset on
//     the primary key), so the interval bounds a retraction's reach to an hour; 0 = every tick.
// Idempotent: deleting an absent path is a no-op (removed 0).
//
// SAFE: a mirror of a DRAFT is deleted, and if the draft is later kept the journal feed
// (`cursor=reviewed`) re-serves it -- its cursor becomes the keep time, past the puller's mark -- and
// with the doc gone existsByPath is false, so the pipeline indexes it again. A released row that is
// RESTORED is re-served the same way (halseth's feed includes rows restored since the mark).
//
// ORDERING: runs inside the pipeline's tick guard, BEFORE the pull. Were a pull to land between this
// job's list fetch and its deletes, it could see a mirror as present, advance past a row kept in that
// window, and then have the mirror deleted with nothing left to re-serve it.

import type { IngestionConfig } from './types.js'
import { loadHwm, saveHwm, getHwm, setHwm } from './hwm.js'
import { retractPath, journalMirrorPath, type RetractableStore } from '../retract.js'

export const RECONCILE_HWM_KEY = 'recall_ineligible_journal'
export const RECONCILE_FULL_AT_KEY = 'recall_reconcile_full_at'
export const RECONCILE_PAGE_LIMIT = 500
/** Hard stop on paging: 200 pages x 500 = 100k ids, far past the table (6.6k rows on 2026-09-26). */
export const RECONCILE_MAX_PAGES = 200

export interface IneligibleItem {
  id: string
  agent?: string
  review_state?: string
  archived?: number
  cursor_at?: string
}

interface IneligiblePage {
  mode?: string
  items: IneligibleItem[]
  next: { since?: string; after_id?: string } | null
}

export interface ReconcileResult {
  mode: 'full' | 'incremental'
  pages: number
  listed: number
  removed_docs: number
  removed_rows: number
  error?: string
}

type FetchFn = typeof fetch

async function fetchPage(
  config: IngestionConfig,
  params: Record<string, string>,
  fetchImpl: FetchFn,
): Promise<IneligiblePage> {
  const url = new URL('/ingest/recall-ineligible', config.halsethUrl)
  url.searchParams.set('limit', String(RECONCILE_PAGE_LIMIT))
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${config.halsethSecret}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Halseth recall-ineligible ${res.status} ${res.statusText}`)
  const body = await res.json() as Partial<IneligiblePage>
  if (!body || !Array.isArray(body.items)) throw new Error('Halseth recall-ineligible: malformed response (no items[])')
  return { items: body.items, next: body.next ?? null, mode: body.mode }
}

/** A later ISO stamp, or the current one; never moves backward. */
function laterOf(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  const a = Date.parse(current)
  const b = Date.parse(next)
  if (Number.isFinite(a) && Number.isFinite(b)) return b > a ? next : current
  return next > current ? next : current
}

export function fullSweepDue(fullAt: string | undefined, fullEveryMinutes: number, now: number): boolean {
  if (!fullAt) return true
  if (fullEveryMinutes <= 0) return true
  const t = Date.parse(fullAt)
  if (!Number.isFinite(t)) return true
  return now - t >= fullEveryMinutes * 60_000
}

export async function runRecallReconcile(
  config: IngestionConfig,
  store: RetractableStore,
  opts: { forceFull?: boolean; now?: () => number; fetchImpl?: FetchFn } = {},
): Promise<ReconcileResult> {
  const now = opts.now ?? Date.now
  const fetchImpl = opts.fetchImpl ?? fetch
  const startedAt = new Date(now()).toISOString()
  let hwm = loadHwm(config.hwmPath)
  const mark = getHwm(hwm, RECONCILE_HWM_KEY)
  const full = opts.forceFull === true || !mark ||
    fullSweepDue(getHwm(hwm, RECONCILE_FULL_AT_KEY), config.recallReconcileFullMinutes ?? 60, now())

  const result: ReconcileResult = { mode: full ? 'full' : 'incremental', pages: 0, listed: 0, removed_docs: 0, removed_rows: 0 }
  let maxCursor = mark
  let params: Record<string, string> = full ? {} : { since: mark! }

  try {
    for (;;) {
      if (result.pages >= RECONCILE_MAX_PAGES) throw new Error(`stopped after ${RECONCILE_MAX_PAGES} pages (paging did not converge)`)
      const page = await fetchPage(config, params, fetchImpl)
      result.pages++
      for (const item of page.items) {
        if (typeof item?.id !== 'string' && typeof item?.id !== 'number') continue
        result.listed++
        const n = retractPath(store, journalMirrorPath(item.id))
        if (n > 0) { result.removed_docs++; result.removed_rows += n }
        maxCursor = laterOf(maxCursor, item.cursor_at)
      }
      // An INCREMENTAL mark advances per page: those pages are ordered by cursor, so everything up to
      // the last cursor on this page is reconciled even if a later page fails. A FULL sweep pages by
      // id, not cursor, so it moves the mark only once it has completed (below).
      if (!full && maxCursor && maxCursor !== getHwm(hwm, RECONCILE_HWM_KEY)) {
        hwm = setHwm(hwm, RECONCILE_HWM_KEY, maxCursor)
        saveHwm(config.hwmPath, hwm)
      }
      if (!page.next) break
      const nextParams: Record<string, string> = {}
      if (page.next.since) nextParams.since = page.next.since
      if (page.next.after_id) nextParams.after_id = page.next.after_id
      if (JSON.stringify(nextParams) === JSON.stringify(params)) throw new Error('paging cursor did not advance')
      params = nextParams
    }
    if (full) {
      // Stamp the START: anything that changed while the sweep ran is within the next sweep's reach.
      // A full sweep that completes with an empty list still arms the incremental path from now.
      hwm = setHwm(hwm, RECONCILE_HWM_KEY, maxCursor ?? startedAt)
      hwm = setHwm(hwm, RECONCILE_FULL_AT_KEY, startedAt)
      saveHwm(config.hwmPath, hwm)
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  const line = `[recall-reconcile] ${result.mode}: pages=${result.pages} listed=${result.listed} ` +
    `removed_docs=${result.removed_docs} removed_rows=${result.removed_rows}`
  if (result.error) console.error(`${line} error=${result.error}`)
  else console.log(line)
  return result
}
