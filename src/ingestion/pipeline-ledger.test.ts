// The ledger lane through the ingestion pipeline (2026-09-26, imp-lane tranche 1).
// Pinned: pullLedger carries `content` verbatim and refuses an unmarked line; the pipeline writes
// exactly ONE chunk per entry at rag/ledger/<id>, chunk text = the line (mark first), content_type
// 'ledger', companion = the subject, with wrapChunk never called; the machine-source skip does not
// drop it; its mark advances on the later of created_at / state_at.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('./deepseek-wrapper.js', () => ({
  wrapChunk: vi.fn(async () => { throw new Error('a ledger line must never be wrapped') }),
}))

import { wrapChunk } from './deepseek-wrapper.js'
import { IngestionPipeline, isMachineGenerated, isVerbatimSource, afterIdKey, afterIdAfter } from './pipeline.js'
import { ALL_PULLERS, pullLedger, LEDGER_MARK_PREFIX } from './puller.js'
import { loadHwm } from './hwm.js'
import { VectorStore } from '../store/vector-store.js'
import type { IngestionConfig, IngestRecord } from './types.js'

const LINE = '〔ledger · gap-reader · 2026-09-26〕 Missing: no companion note recorded for the hangout session on 2026-09-26 (42 minutes). Source: session sess-1.'

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'led_1', companion_id: 'drevan', function: 'gap-reader', content: LINE,
    source_kind: 'session', source_ref: 'sess-1', observed_on: '2026-09-26', state: 'open',
    created_at: '2026-09-26T10:00:00.000Z', state_at: null, ...over,
  }
}

let dir: string
let config: IngestionConfig
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-pipe-'))
  config = {
    halsethUrl: 'https://h.example', halsethSecret: 'sek', deepseekApiKey: 'd', deepseekModel: 'm',
    cronSchedule: '', concurrencyLimit: 1, concurrencyDelayMs: 0, embeddingBatchSize: 1,
    hwmPath: path.join(dir, 'hwm.json'), evaluatorCronSchedule: '', sitPromptCronSchedule: '',
    patternSynthCronSchedule: '', personaFeederCronSchedule: '',
  }
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  fs.rmSync(dir, { recursive: true, force: true })
})

function stubFeed(rows: unknown[]) {
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url)
    return new Response(JSON.stringify(url.pathname === '/ingest/ledger' ? rows : []), { status: 200 })
  }))
  return calls
}

describe('pullLedger', () => {
  it('is registered as its own source (own hwm key) and pages /ingest/ledger with since + limit', async () => {
    expect(ALL_PULLERS.find(p => p.source === 'ledger')?.pull).toBe(pullLedger)
    const calls = stubFeed([row()])
    await pullLedger(config, '2026-09-25T00:00:00.000Z')
    expect(calls[0]!.pathname).toBe('/ingest/ledger')
    expect(calls[0]!.searchParams.get('since')).toBe('2026-09-25T00:00:00.000Z')
    expect(calls[0]!.searchParams.get('limit')).toBe('100')
  })

  it('carries content verbatim (not the JSON row); companion = the subject; cursor = later of created_at/state_at', async () => {
    stubFeed([row(), row({ id: 'led_2', state: 'kept', state_at: '2026-09-26T12:00:00.000Z' })])
    const { records, error } = await pullLedger(config)
    expect(error).toBeUndefined()
    expect(records[0]).toMatchObject({ id: 'led_1', source_type: 'ledger', content: LINE, companion_id: 'drevan', cursor: '2026-09-26T10:00:00.000Z' })
    expect(records[1]!.cursor).toBe('2026-09-26T12:00:00.000Z')
    expect(records[0]!.content.startsWith(LEDGER_MARK_PREFIX)).toBe(true)
  })

  it('refuses to index a line that lost its mark: handed on as a SKIP record (so the mark can move), logged once', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFeed([row({ id: 'led_bad', content: 'Missing: stripped of its mark.' }), row({ id: 'led_ok' })])
    const { records } = await pullLedger(config)
    expect(records.map(r => [r.id, r.skip ?? null])).toEqual([['led_bad', 'unmarked'], ['led_ok', null]])
    expect(records[0]!.content).toBe('')
    expect(err).toHaveBeenCalledTimes(1)
  })
})

describe('pipeline: ledger records', () => {
  const ledgerRecord: IngestRecord = { id: 'led_1' as unknown as number, source_type: 'ledger', content: LINE, created_at: '2026-09-26T10:00:00.000Z', companion_id: 'drevan' }

  it('is verbatim and is not skipped as machine-generated', () => {
    expect(isVerbatimSource(ledgerRecord)).toBe(true)
    expect(isMachineGenerated(ledgerRecord)).toBe(false)
  })

  it('writes exactly one chunk per entry, text = the line mark first, no wrapChunk; re-pull is a no-op', async () => {
    // Only the ledger feed returns rows; every other source's fetch gets [].
    stubFeed([row(), row({ id: 'led_2', companion_id: 'gaia', content: LINE.replace('gap-reader', 'drift-reader') })])
    const store = new VectorStore(':memory:')
    store.initialize()
    const embed = vi.fn(async () => [0.1, 0.2, 0.3])
    const pipeline = new IngestionPipeline(config, store, { embed } as never)
    await pipeline.run()

    expect(wrapChunk).not.toHaveBeenCalled()
    const chunks = store.filterByPathPrefix('rag/ledger/', 50)
    expect(chunks.map(c => c.vault_path).sort()).toEqual(['rag/ledger/led_1', 'rag/ledger/led_2'])
    const one = chunks.find(c => c.vault_path === 'rag/ledger/led_1')!
    expect(one.chunk_text).toBe(LINE)
    expect(one.prefixed_text).toBe(LINE)
    expect(one.chunk_text.startsWith(LEDGER_MARK_PREFIX)).toBe(true)
    expect(one.content_type).toBe('ledger')
    expect(one.companion).toBe('drevan')
    expect(store.countByPath('rag/ledger/led_1')).toBe(1)
    expect(embed).toHaveBeenCalledWith(LINE)
    expect(loadHwm(config.hwmPath).ledger).toBe('2026-09-26T10:00:00.000Z')

    // Lexical search sees the mark-first text (FTS is built on prefixed_text).
    expect(store.hybridSearch(null, 'companion note recorded hangout', 10).map(r => r.vault_path)).toContain('rag/ledger/led_1')

    await pipeline.run()
    expect(store.countByPath('rag/ledger/led_1')).toBe(1)
    store.close()
  })
})

// ── Tie at a page boundary (2026-09-26 integration pass) ─────────────────────────────────────────
// halseth's /ingest/ledger is STRICTLY after `since`, ordered (cursor_at, id), and pages with
// next = { since, after_id }. This fake implements exactly that keyset, so a page of 100 that ends in
// the middle of a cursor tie is real here (the stub above ignores since/limit and would mask it).
function keysetLedgerFeed(rows: Array<Record<string, unknown>>) {
  type R = Record<string, unknown> & { id: string; cursor_at: string }
  const sorted = ([...rows] as R[]).sort((a, b) => (a.cursor_at < b.cursor_at ? -1 : a.cursor_at > b.cursor_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const calls: URL[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.pathname !== '/ingest/ledger') return new Response('[]', { status: 200 })
    calls.push(url)
    const since = url.searchParams.get('since') ?? '1970-01-01T00:00:00.000Z'
    const after = url.searchParams.get('after_id') ?? ''
    const limit = Number(url.searchParams.get('limit') ?? '100')
    const items = sorted
      .filter(r => r.cursor_at > since || (after !== '' && r.cursor_at === since && r.id > after))
      .slice(0, limit)
    const last = items[items.length - 1]
    const next = items.length < limit || !last ? null : { since: last.cursor_at, after_id: last.id }
    return new Response(JSON.stringify({ items, next }), { status: 200 })
  }))
  return calls
}

describe('pipeline: ledger paging with a cursor tie at the page boundary', () => {
  it('indexes every row across ticks: after_id is persisted beside the mark and sent back', async () => {
    const T = '2026-09-26T11:00:00.000Z'
    const rows = Array.from({ length: 101 }, (_, i) => {
      const id = `led_${String(i).padStart(4, '0')}`
      // rows 97..100 share one cursor; the page of 100 ends at row 99, mid-tie.
      const cursor_at = i >= 97 ? T : new Date(Date.parse('2026-09-26T10:00:00.000Z') + i * 1000).toISOString()
      return row({ id, content: LINE.replace('sess-1', `sess-${i}`), created_at: cursor_at, cursor_at })
    })
    const calls = keysetLedgerFeed(rows)
    const store = new VectorStore(':memory:')
    store.initialize()
    const pipeline = new IngestionPipeline(config, store, { embed: vi.fn(async () => [0.1, 0.2, 0.3]) } as never)

    await pipeline.run()
    expect(store.filterByPathPrefix('rag/ledger/', 500)).toHaveLength(100)
    const hwm1 = loadHwm(config.hwmPath)
    expect(hwm1.ledger).toBe(T)
    expect(hwm1[afterIdKey('ledger')]).toBe('led_0099')

    await pipeline.run()
    expect(calls[1]!.searchParams.get('since')).toBe(T)
    expect(calls[1]!.searchParams.get('after_id')).toBe('led_0099')
    const paths = store.filterByPathPrefix('rag/ledger/', 500).map(c => c.vault_path)
    expect(paths).toHaveLength(101)
    expect(paths).toContain('rag/ledger/led_0100')
    expect(loadHwm(config.hwmPath)[afterIdKey('ledger')]).toBe('led_0100')

    // A third tick finds nothing new and moves nothing.
    await pipeline.run()
    expect(store.filterByPathPrefix('rag/ledger/', 500)).toHaveLength(101)
    store.close()
  })

  it('afterIdAfter: moves with the mark, advances within a tie, ignores records without a tiebreak', () => {
    const rec = (id: string, cursor: string): IngestRecord => ({ id: id as unknown as number, source_type: 'ledger', content: LINE, created_at: cursor, cursor, cursor_id: id })
    const T = '2026-09-26T11:00:00.000Z'
    expect(afterIdAfter(T, 'led_b', rec('led_a', T), true)).toBe('led_a')        // mark moved to it
    expect(afterIdAfter(T, 'led_a', rec('led_b', T), false)).toBe('led_b')       // tie, later id
    expect(afterIdAfter(T, 'led_b', rec('led_a', T), false)).toBeNull()          // tie, earlier id
    expect(afterIdAfter(T, 'led_a', rec('led_z', '2026-09-26T10:00:00.000Z'), false)).toBeNull() // behind the mark
    expect(afterIdAfter(T, undefined, { id: 1, source_type: 'feeling', content: '{}', created_at: T }, false)).toBeNull()
  })
})

describe('pipeline: a refused (unmarked) ledger row never stalls the feed (review S2)', () => {
  it('a page made only of refused rows moves the mark and after_id past them, indexes nothing, and is not re-fetched', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rows = [
      row({ id: 'led_a', content: 'Missing: no mark.', created_at: '2026-09-26T10:00:00.000Z', cursor_at: '2026-09-26T10:00:00.000Z' }),
      row({ id: 'led_b', content: 'Missing: no mark either.', created_at: '2026-09-26T10:00:01.000Z', cursor_at: '2026-09-26T10:00:01.000Z' }),
    ]
    const calls: URL[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input))
      calls.push(url)
      if (url.pathname !== '/ingest/ledger') return new Response('[]', { status: 200 })
      const since = url.searchParams.get('since')
      const served = rows.filter(r => !since || (r as { cursor_at?: string }).cursor_at! > since)
      return new Response(JSON.stringify(served), { status: 200 })
    }))
    const store = new VectorStore(':memory:')
    store.initialize()
    const pipeline = new IngestionPipeline(config, store, { embed: vi.fn(async () => [0.1, 0.2, 0.3]) } as never)

    await pipeline.run()
    expect(store.filterByPathPrefix('rag/ledger/', 50)).toHaveLength(0)
    const hwm = loadHwm(config.hwmPath)
    expect(hwm.ledger).toBe('2026-09-26T10:00:01.000Z')
    expect(hwm[afterIdKey('ledger')]).toBe('led_b')
    expect(err).toHaveBeenCalledTimes(2)

    await pipeline.run()
    expect(err).toHaveBeenCalledTimes(2)   // once per row, ever: the second tick is past them
    store.close()
  })
})
