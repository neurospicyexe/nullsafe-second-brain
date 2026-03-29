import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IngestionConfig } from './types.js'

// Mock fs so we never touch disk
vi.mock('fs', () => ({
  default: {
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
  },
}))

// Mock chunker
vi.mock('./chunker.js', () => ({
  semanticChunk: vi.fn(),
}))

// Mock deepseek-wrapper
vi.mock('./deepseek-wrapper.js', () => ({
  wrapChunk: vi.fn(),
}))

import fs from 'fs'
import { semanticChunk } from './chunker.js'
import { wrapChunk } from './deepseek-wrapper.js'
import { withConcurrencyLimit, processCorpus } from './corpus.js'

const mockReaddirSync = fs.readdirSync as ReturnType<typeof vi.fn>
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>
const mockSemanticChunk = semanticChunk as ReturnType<typeof vi.fn>
const mockWrapChunk = wrapChunk as ReturnType<typeof vi.fn>

const mockConfig: IngestionConfig = {
  halsethUrl: 'https://halseth.example.com',
  halsethSecret: 'secret',
  deepseekApiKey: 'ds-key',
  deepseekModel: 'deepseek-chat',
  cronSchedule: '*/20 * * * *',
  concurrencyLimit: 3,
  concurrencyDelayMs: 0,
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe('withConcurrencyLimit', () => {
  it('processes all items', async () => {
    const items = [1, 2, 3, 4, 5]
    const processed: number[] = []

    await withConcurrencyLimit(items, 2, 0, async (item) => {
      processed.push(item)
    })

    expect(processed.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('respects concurrency limit -- max N concurrent at a time', async () => {
    const items = [1, 2, 3, 4, 5, 6]
    let concurrent = 0
    let maxConcurrent = 0
    const limit = 2

    await withConcurrencyLimit(items, limit, 0, async (_item) => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      // Yield to let other promises in the same batch start
      await new Promise(resolve => setTimeout(resolve, 0))
      concurrent--
    })

    expect(maxConcurrent).toBeLessThanOrEqual(limit)
  })
})

describe('processCorpus', () => {
  it('skips already-indexed files (existsByPath returns true)', async () => {
    mockReaddirSync.mockReturnValue(['convo1.md'])
    mockReadFileSync.mockReturnValue('Some markdown content')
    mockSemanticChunk.mockResolvedValue([
      { label: 'Opening', content: 'First chunk.' },
    ])

    const store = makeMockStore(true) // already indexed
    const embedder = makeMockEmbedder()

    await processCorpus(
      { intakeDir: '/fake/dir', sourceType: 'historical_corpus' },
      mockConfig,
      store as never,
      embedder as never,
    )

    expect(mockSemanticChunk).toHaveBeenCalledOnce()
    expect(store.existsByPath).toHaveBeenCalledWith('rag/historical_corpus/convo1.md/0')
    expect(mockWrapChunk).not.toHaveBeenCalled()
    expect(embedder.embed).not.toHaveBeenCalled()
    expect(store.insert).not.toHaveBeenCalled()
  })

  it('calls semanticChunk, wrapChunk, embedder.embed, store.insert for new files', async () => {
    mockReaddirSync.mockReturnValue(['convo1.md'])
    mockReadFileSync.mockReturnValue('Some markdown content')

    const chunks = [
      { label: 'Opening', content: 'First chunk.' },
      { label: 'Pivot', content: 'Second chunk.' },
    ]
    mockSemanticChunk.mockResolvedValue(chunks)
    mockWrapChunk.mockResolvedValue('wrapped text')

    const store = makeMockStore(false) // not indexed
    const embedder = makeMockEmbedder([0.1, 0.2])

    await processCorpus(
      { intakeDir: '/fake/dir', sourceType: 'historical_corpus' },
      mockConfig,
      store as never,
      embedder as never,
    )

    expect(mockSemanticChunk).toHaveBeenCalledWith('Some markdown content', mockConfig)
    expect(mockWrapChunk).toHaveBeenCalledTimes(2)
    expect(embedder.embed).toHaveBeenCalledTimes(2)
    expect(store.insert).toHaveBeenCalledTimes(2)

    expect(store.insert).toHaveBeenCalledWith({
      vault_path: 'rag/historical_corpus/convo1.md/0',
      chunk_text: 'wrapped text',
      embedding: [0.1, 0.2],
      companion: null,
      content_type: 'historical_corpus',
      tags: ['Opening'],
    })
    expect(store.insert).toHaveBeenCalledWith({
      vault_path: 'rag/historical_corpus/convo1.md/1',
      chunk_text: 'wrapped text',
      embedding: [0.1, 0.2],
      companion: null,
      content_type: 'historical_corpus',
      tags: ['Pivot'],
    })
  })

  it('skips unreadable files and continues to next', async () => {
    mockReaddirSync.mockReturnValue(['bad.md', 'good.md'])
    mockReadFileSync
      .mockImplementationOnce(() => { throw new Error('ENOENT') })
      .mockReturnValueOnce('Good content')
    mockSemanticChunk.mockResolvedValue([{ label: 'Only', content: 'Good chunk.' }])
    mockWrapChunk.mockResolvedValue('wrapped')

    const store = makeMockStore(false)
    const embedder = makeMockEmbedder()

    await processCorpus(
      { intakeDir: '/fake/dir', sourceType: 'historical_corpus' },
      mockConfig,
      store as never,
      embedder as never,
    )

    // bad.md failed to read; good.md succeeded
    expect(mockSemanticChunk).toHaveBeenCalledOnce()
    expect(store.insert).toHaveBeenCalledOnce()
  })

  it('skips files that fail chunking and continues to next', async () => {
    mockReaddirSync.mockReturnValue(['fail.md', 'ok.md'])
    mockReadFileSync.mockReturnValue('Some content')
    mockSemanticChunk
      .mockRejectedValueOnce(new Error('DeepSeek timeout'))
      .mockResolvedValueOnce([{ label: 'Good', content: 'Good chunk.' }])
    mockWrapChunk.mockResolvedValue('wrapped')

    const store = makeMockStore(false)
    const embedder = makeMockEmbedder()

    await processCorpus(
      { intakeDir: '/fake/dir', sourceType: 'historical_corpus' },
      mockConfig,
      store as never,
      embedder as never,
    )

    expect(store.insert).toHaveBeenCalledOnce()
  })

  it('ignores non-.md files in the directory', async () => {
    mockReaddirSync.mockReturnValue(['convo.md', 'notes.txt', 'image.png'])
    mockReadFileSync.mockReturnValue('Markdown content')
    mockSemanticChunk.mockResolvedValue([{ label: 'A', content: 'chunk' }])
    mockWrapChunk.mockResolvedValue('wrapped')

    const store = makeMockStore(false)
    const embedder = makeMockEmbedder()

    await processCorpus(
      { intakeDir: '/fake/dir', sourceType: 'historical_corpus' },
      mockConfig,
      store as never,
      embedder as never,
    )

    // Only convo.md processed
    expect(mockSemanticChunk).toHaveBeenCalledOnce()
  })
})
