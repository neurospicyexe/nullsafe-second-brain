import { describe, it, expect, vi, beforeEach } from 'vitest'
import { semanticChunk, splitIntoSegments } from './chunker.js'
import type { IngestionConfig } from './types.js'

const mockConfig: Pick<IngestionConfig, 'deepseekApiKey' | 'deepseekModel'> = {
  deepseekApiKey: 'test-key',
  deepseekModel: 'deepseek-chat',
}

const validChunks = [
  { label: 'Opening', content: 'First part of the conversation.' },
  { label: 'Pivot', content: 'Second part after a shift.' },
]

function makeFetchMock(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('splitIntoSegments', () => {
  it('returns single segment when content fits within maxChars', () => {
    const content = 'Hello world\n\nSecond paragraph'
    const segments = splitIntoSegments(content, 1000)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe(content)
  })

  it('splits at paragraph boundaries when content exceeds maxChars', () => {
    const para1 = 'A'.repeat(60)
    const para2 = 'B'.repeat(60)
    const para3 = 'C'.repeat(60)
    const content = `${para1}\n\n${para2}\n\n${para3}`
    const segments = splitIntoSegments(content, 100)
    expect(segments.length).toBeGreaterThan(1)
    // Every segment must fit within maxChars
    for (const seg of segments) {
      expect(seg.length).toBeLessThanOrEqual(100)
    }
    // All original content is preserved across segments
    const rejoined = segments.join('\n\n')
    expect(rejoined).toContain(para1)
    expect(rejoined).toContain(para2)
    expect(rejoined).toContain(para3)
  })

  it('handles content with no double-newlines as a single paragraph', () => {
    const content = 'No paragraph breaks here at all'
    const segments = splitIntoSegments(content, 10)
    // Can't split further -- single para goes through as-is
    expect(segments).toHaveLength(1)
    expect(segments[0]).toBe(content)
  })
})

describe('semanticChunk', () => {
  it('returns parsed chunks from a valid JSON response', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: JSON.stringify(validChunks) } }],
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await semanticChunk('Some conversation text', mockConfig)

    expect(result).toEqual(validChunks)
    expect(fetchMock).toHaveBeenCalledOnce()
    const callArgs = fetchMock.mock.calls[0]
    expect(callArgs[0]).toBe('https://api.deepseek.com/chat/completions')
    expect(JSON.parse(callArgs[1].body).model).toBe('deepseek-chat')
  })

  it('strips markdown code block wrapper before parsing', async () => {
    const wrapped = '```json\n' + JSON.stringify(validChunks) + '\n```'
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: wrapped } }],
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await semanticChunk('Some text', mockConfig)
    expect(result).toEqual(validChunks)
  })

  it('strips plain code block wrapper before parsing', async () => {
    const wrapped = '```\n' + JSON.stringify(validChunks) + '\n```'
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: wrapped } }],
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await semanticChunk('Some text', mockConfig)
    expect(result).toEqual(validChunks)
  })

  it('throws when response JSON is invalid', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: 'not valid json at all' } }],
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(semanticChunk('Some text', mockConfig))
      .rejects.toThrow('Failed to parse DeepSeek chunk response')
  })

  it('throws when response is not ok', async () => {
    const fetchMock = makeFetchMock({}, false, 429)
    vi.stubGlobal('fetch', fetchMock)

    await expect(semanticChunk('Some text', mockConfig))
      .rejects.toThrow('DeepSeek chunking failed: 429')
  })

  it('calls chunkSegment multiple times when content exceeds 80K chars', async () => {
    const fetchMock = makeFetchMock({
      choices: [{ message: { content: JSON.stringify([validChunks[0]]) } }],
    })
    vi.stubGlobal('fetch', fetchMock)

    // Build content that exceeds 80K by having 3 segments of ~40K each
    const para = 'X'.repeat(40_000)
    const content = `${para}\n\n${para}\n\n${para}`

    const result = await semanticChunk(content, mockConfig)

    // fetch called more than once (one per segment)
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1)
    // results from all segments combined
    expect(result.length).toBe(fetchMock.mock.calls.length)
  })
})
