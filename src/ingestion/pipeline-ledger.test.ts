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
import { IngestionPipeline, isMachineGenerated, isVerbatimSource } from './pipeline.js'
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

  it('refuses to index a line that lost its mark', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stubFeed([row({ content: 'Missing: stripped of its mark.' }), row({ id: 'led_ok' })])
    const { records } = await pullLedger(config)
    expect(records.map(r => r.id)).toEqual(['led_ok'])
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
