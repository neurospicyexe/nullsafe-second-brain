// The other half of the recall reconcile (2026-09-26): deleting the mirror of a DRAFT is safe only if
// the row comes back when it is kept. The journal feed (cursor=reviewed) re-serves a kept-later row
// with cursor_at = its keep time, past the puller's mark; the pipeline dedups on existsByPath -- and
// after the reconcile deleted the doc that is false, so it must index the row again. Real store, real
// hwm file, real reconcile; only the network (puller + halseth list) and the LLM wrapper are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IngestRecord, IngestionConfig } from './types.js'

vi.mock('./puller.js', () => ({ ALL_PULLERS: [{ source: 'companion_journal', pull: vi.fn() }] }))
vi.mock('./deepseek-wrapper.js', () => ({ wrapChunk: vi.fn(async (r: IngestRecord) => `book report of ${r.id}`) }))

import { ALL_PULLERS } from './puller.js'
import { IngestionPipeline } from './pipeline.js'
import { runRecallReconcile } from './recall-reconcile.js'
import { loadHwm } from './hwm.js'
import { VectorStore } from '../store/vector-store.js'
import { journalMirrorPath } from '../retract.js'

const pull = ALL_PULLERS[0]!.pull as unknown as ReturnType<typeof vi.fn>
const embedder = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) }

let dir: string
let config: IngestionConfig
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repull-'))
  config = {
    halsethUrl: 'https://h.example', halsethSecret: 'sek', deepseekApiKey: 'd', deepseekModel: 'm',
    cronSchedule: '', concurrencyLimit: 1, concurrencyDelayMs: 0, embeddingBatchSize: 1,
    hwmPath: path.join(dir, 'hwm.json'), evaluatorCronSchedule: '', sitPromptCronSchedule: '',
    patternSynthCronSchedule: '', personaFeederCronSchedule: '',
  }
  pull.mockReset()
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const row = (cursor: string): IngestRecord => ({
  id: 'j-kept-later' as unknown as number,
  source_type: 'companion_journal',
  content: JSON.stringify({ id: 'j-kept-later', agent: 'drevan', note_text: 'I chose these words', source: 'memory_judge' }),
  created_at: '2026-09-10T00:00:00.000Z',
  cursor,
  companion_id: 'drevan',
})

describe('a mirror deleted by the reconcile is re-indexed when its draft is later kept', () => {
  it('pre-0132 mirror -> reconcile deletes it (draft) -> keep -> the next pull indexes it again', async () => {
    const store = new VectorStore(':memory:')
    store.initialize()
    const pipeline = new IngestionPipeline(config, store, embedder as never)
    const p = journalMirrorPath('j-kept-later')

    // 1. The pre-0132 world: the row was pulled while it was still "kept" by default.
    pull.mockResolvedValueOnce({ records: [row('2026-09-10T00:00:00.000Z')] })
    await pipeline.run()
    expect(store.existsByPath(p)).toBe(true)
    expect(loadHwm(config.hwmPath).companion_journal).toBe('2026-09-10T00:00:00.000Z')

    // 2. 0132 backfills it to draft; the reconcile lists it and deletes the mirror.
    const list = vi.fn(async () => new Response(JSON.stringify({ items: [{ id: 'j-kept-later', cursor_at: '2026-09-10T00:00:00.000Z' }], next: null })))
    const r = await runRecallReconcile(config, store, { fetchImpl: list as unknown as typeof fetch, forceFull: true })
    expect(r.removed_docs).toBe(1)
    expect(store.existsByPath(p)).toBe(false)

    // 3. While a draft, the kept-only feed does not serve it: nothing comes back.
    pull.mockResolvedValueOnce({ records: [] })
    await pipeline.run()
    expect(store.existsByPath(p)).toBe(false)

    // 4. The owner keeps it: cursor=reviewed serves it with cursor_at = the keep, past the mark.
    pull.mockResolvedValueOnce({ records: [row('2026-09-26T10:00:00.000Z')] })
    await pipeline.run()
    expect(pull).toHaveBeenLastCalledWith(config, '2026-09-10T00:00:00.000Z')
    expect(store.existsByPath(p)).toBe(true)
    expect(store.hybridSearch(null, 'book report', 5).map(x => x.vault_path)).toContain(p)
    expect(loadHwm(config.hwmPath).companion_journal).toBe('2026-09-26T10:00:00.000Z')
  })
})
