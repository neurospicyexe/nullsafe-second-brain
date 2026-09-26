import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IngestRecord, IngestionConfig } from './types.js'

// Mock puller and wrapper modules before importing pipeline
vi.mock('./puller.js', () => ({
  ALL_PULLERS: [
    { source: 'synthesis_summary', pull: vi.fn() },
  ],
}))

vi.mock('./deepseek-wrapper.js', () => ({
  wrapChunk: vi.fn(),
}))

// Mock hwm so saveHwm doesn't touch disk
vi.mock('./hwm.js', () => ({
  loadHwm: vi.fn().mockReturnValue({}),
  saveHwm: vi.fn(),
  getHwm: vi.fn().mockImplementation((hwm: Record<string, string>, source: string) => hwm[source]),
  setHwm: vi.fn().mockImplementation((hwm: Record<string, string>, source: string, ts: string) => ({ ...hwm, [source]: ts })),
}))

import { ALL_PULLERS } from './puller.js'
import { wrapChunk } from './deepseek-wrapper.js'
import { loadHwm, saveHwm, setHwm } from './hwm.js'
import { IngestionPipeline } from './pipeline.js'

const mockPull = ALL_PULLERS[0].pull as ReturnType<typeof vi.fn>
const mockWrapChunk = wrapChunk as ReturnType<typeof vi.fn>

const mockRecord: IngestRecord = {
  id: 42,
  source_type: 'synthesis_summary',
  content: '{"summary": "test content"}',
  created_at: '2026-03-25T10:00:00Z',
  companion_id: 'cypher',
}

const mockConfig: IngestionConfig = {
  halsethUrl: 'https://halseth.example.com',
  halsethSecret: 'secret',
  deepseekApiKey: 'ds-key',
  deepseekModel: 'deepseek-chat',
  cronSchedule: '*/20 * * * *',
  concurrencyLimit: 3,
  concurrencyDelayMs: 500,
  embeddingBatchSize: 20,
  hwmPath: '/tmp/test-hwm.json',
  evaluatorCronSchedule: '0 */6 * * *',
  sitPromptCronSchedule: '0 */12 * * *',
  patternSynthCronSchedule: '0 2 * * 0',
  personaFeederCronSchedule: '30 */6 * * *',
}

function makeMockStore(existsByPathResult = false) {
  return {
    existsByPath: vi.fn().mockReturnValue(existsByPathResult),
    insert: vi.fn(),
  }
}

function makeMockEmbedder(embedding = [0.1, 0.2, 0.3]) {
  return {
    embed: vi.fn().mockResolvedValue(embedding),
  }
}

const mockLoadHwm = loadHwm as ReturnType<typeof vi.fn>
const mockSaveHwm = saveHwm as ReturnType<typeof vi.fn>
const mockSetHwm = setHwm as ReturnType<typeof vi.fn>

beforeEach(() => {
  // Reset call history and once-queues, then restore persistent implementations
  mockPull.mockReset()
  mockWrapChunk.mockReset()
  mockLoadHwm.mockReset().mockReturnValue({})
  mockSaveHwm.mockReset()
  mockSetHwm.mockReset().mockImplementation(
    (hwm: Record<string, string>, source: string, ts: string) => ({ ...hwm, [source]: ts })
  )
})

describe('IngestionPipeline.run()', () => {
  it('skips already-indexed record (existsByPath returns true) -- and advances the mark past it', async () => {
    mockPull.mockResolvedValueOnce({ records: [mockRecord] })
    mockWrapChunk.mockResolvedValueOnce('wrapped text')

    const store = makeMockStore(true) // already indexed
    const embedder = makeMockEmbedder()
    const pipeline = new IngestionPipeline(mockConfig, store as never, embedder as never)

    await pipeline.run()

    expect(store.existsByPath).toHaveBeenCalledWith('rag/synthesis_summary/42')
    expect(mockWrapChunk).not.toHaveBeenCalled()
    expect(embedder.embed).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
    // 2026-09-26: a duplicate IS indexed, so the mark moves past it. Before, a page of 100 duplicates
    // (e.g. after a one-time rewind) never moved the mark and was re-fetched every cycle forever.
    expect(mockSaveHwm).toHaveBeenCalledTimes(1)
    expect(mockSetHwm).toHaveBeenLastCalledWith({}, 'synthesis_summary', '2026-03-25T10:00:00Z')
  })

  it('advances on record.cursor when the feed supplies one (a row kept after the mark), never on its older created_at', async () => {
    const kept = { ...mockRecord, id: 7, created_at: '2026-09-21T10:00:00.000Z', cursor: '2026-09-26T08:00:00.000Z' }
    mockPull.mockResolvedValueOnce({ records: [kept] })
    mockWrapChunk.mockResolvedValueOnce('wrapped')
    const store = makeMockStore(false)
    await new IngestionPipeline(mockConfig, store as never, makeMockEmbedder() as never).run()
    expect(store.insert).toHaveBeenCalledTimes(1)
    expect(mockSetHwm).toHaveBeenLastCalledWith({}, 'synthesis_summary', '2026-09-26T08:00:00.000Z')
  })

  it('never moves the mark backward (an old-shaped record behind the mark leaves it alone)', async () => {
    mockLoadHwm.mockReturnValue({ synthesis_summary: '2026-09-25T00:00:00.000Z' })
    const behind = { ...mockRecord, id: 8, created_at: '2026-09-21T10:00:00.000Z' }
    mockPull.mockResolvedValueOnce({ records: [behind] })
    mockWrapChunk.mockResolvedValueOnce('wrapped')
    const store = makeMockStore(false)
    await new IngestionPipeline(mockConfig, store as never, makeMockEmbedder() as never).run()
    expect(store.insert).toHaveBeenCalledTimes(1)          // still indexed (idempotent on id)
    expect(mockSetHwm).not.toHaveBeenCalled()             // but the mark stays put
  })

  it('processes a new record: calls wrapChunk, embed, store.insert, saves HWM', async () => {
    mockPull.mockResolvedValueOnce({ records: [mockRecord] })
    mockWrapChunk.mockResolvedValueOnce('wrapped text')

    const store = makeMockStore(false) // not yet indexed
    const embedder = makeMockEmbedder([0.1, 0.2, 0.3])
    const pipeline = new IngestionPipeline(mockConfig, store as never, embedder as never)

    await pipeline.run()

    expect(store.existsByPath).toHaveBeenCalledWith('rag/synthesis_summary/42')
    expect(mockWrapChunk).toHaveBeenCalledWith(mockRecord, mockConfig)
    expect(embedder.embed).toHaveBeenCalledWith('wrapped text')
    expect(store.insert).toHaveBeenCalledWith({
      vault_path: 'rag/synthesis_summary/42',
      companion: 'cypher',
      content_type: 'synthesis_summary',
      chunk_text: 'wrapped text',
      prefixed_text: 'wrapped text', // must be set so the chunk enters the FTS5 keyword index
      embedding: [0.1, 0.2, 0.3],
      tags: [],
      valence: null, // no emotion key in mockRecord content
    })
    expect(mockSetHwm).toHaveBeenCalledWith({}, 'synthesis_summary', '2026-03-25T10:00:00Z')
    expect(mockSaveHwm).toHaveBeenCalledWith(mockConfig.hwmPath, expect.objectContaining({ synthesis_summary: '2026-03-25T10:00:00Z' }))
  })

  it('on wrapChunk failure: logs error, does NOT advance HWM, continues to next record', async () => {
    const secondRecord: IngestRecord = { ...mockRecord, id: 43, created_at: '2026-03-25T11:00:00Z' }
    mockPull.mockResolvedValueOnce({ records: [mockRecord, secondRecord] })
    // First call (record 42) succeeds, second call (record 43) throws
    mockWrapChunk
      .mockResolvedValueOnce('wrapped first')
      .mockRejectedValueOnce(new Error('DeepSeek timeout'))

    const store = makeMockStore(false)
    const embedder = makeMockEmbedder()
    const pipeline = new IngestionPipeline(mockConfig, store as never, embedder as never)

    await pipeline.run()

    // First record (42): succeeded -- inserted, HWM advanced
    // Second record (43): wrapChunk threw -- no insert, no HWM advancement for it
    expect(store.insert).toHaveBeenCalledTimes(1)
    expect(store.insert).toHaveBeenCalledWith(expect.objectContaining({ vault_path: 'rag/synthesis_summary/42' }))
    // HWM only advanced for the successful first record
    expect(mockSetHwm).toHaveBeenCalledTimes(1)
    expect(mockSetHwm).toHaveBeenCalledWith(expect.anything(), 'synthesis_summary', '2026-03-25T10:00:00Z')
  })

  it('on pull failure: logs error, continues to next source', async () => {
    mockPull.mockResolvedValueOnce({ records: [], error: 'network error' })

    const store = makeMockStore(false)
    const embedder = makeMockEmbedder()
    const pipeline = new IngestionPipeline(mockConfig, store as never, embedder as never)

    await pipeline.run()

    expect(mockWrapChunk).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
    expect(mockSaveHwm).not.toHaveBeenCalled()
  })
})
