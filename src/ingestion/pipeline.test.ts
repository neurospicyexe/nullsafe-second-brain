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
  getHwm: vi.fn().mockReturnValue(undefined),
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
  it('skips already-indexed record (existsByPath returns true)', async () => {
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
    expect(mockSaveHwm).not.toHaveBeenCalled()
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
      embedding: [0.1, 0.2, 0.3],
      tags: [],
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
