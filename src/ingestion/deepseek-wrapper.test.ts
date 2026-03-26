import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildWrapPrompt, parseWrappedOutput, wrapChunk } from './deepseek-wrapper.js'
import type { IngestRecord } from './types.js'

const baseRecord: IngestRecord = {
  id: 1,
  source_type: 'synthesis_summary',
  content: '{"text":"Some content here"}',
  created_at: '2026-03-25T12:00:00.000Z',
  companion_id: 'cypher',
  thread_key: 'thread-abc',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildWrapPrompt', () => {
  it('includes source_type in the prompt', () => {
    const prompt = buildWrapPrompt(baseRecord)
    expect(prompt).toContain('synthesis_summary')
  })

  it('includes companion_id in the prompt', () => {
    const prompt = buildWrapPrompt(baseRecord)
    expect(prompt).toContain('cypher')
  })

  it("falls back to 'unknown' when companion_id is undefined", () => {
    const record: IngestRecord = { ...baseRecord, companion_id: undefined }
    const prompt = buildWrapPrompt(record)
    expect(prompt).toContain('unknown')
  })
})

describe('parseWrappedOutput', () => {
  it('prepends preamble to content with double newline', () => {
    const result = parseWrappedOutput('This is the preamble.', 'original content')
    expect(result).toBe('This is the preamble.\n\noriginal content')
  })

  it('trims whitespace from preamble before prepending', () => {
    const result = parseWrappedOutput('  Preamble with spaces.  ', 'original content')
    expect(result).toBe('Preamble with spaces.\n\noriginal content')
  })
})

describe('wrapChunk', () => {
  const config = { deepseekApiKey: 'test-key', deepseekModel: 'deepseek-chat' }

  it('calls fetch with correct URL and auth header, returns prepended string', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Test preamble.' } }],
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await wrapChunk(baseRecord, config)

    expect(mockFetch).toHaveBeenCalledOnce()
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key')
    expect(result).toBe(`Test preamble.\n\n${baseRecord.content}`)
  })

  it('throws on non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }))

    await expect(wrapChunk(baseRecord, config)).rejects.toThrow('DeepSeek API error 429')
  })

  it('throws when preamble is empty string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
      }),
    }))

    await expect(wrapChunk(baseRecord, config)).rejects.toThrow('DeepSeek returned empty preamble')
  })
})
