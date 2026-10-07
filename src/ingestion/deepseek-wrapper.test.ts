import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildWrapPrompt, parseWrappedOutput, wrapChunk } from './deepseek-wrapper.js'
import { HOUSEHOLD_GROUNDING_RULE, resetHouseholdFactsCache } from './household-grounding.js'
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
  vi.unstubAllGlobals()
  resetHouseholdFactsCache()
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

// 2026-10-07: the preamble called Lucy (a Dalmatian) a "sick cat". The wrap now carries the
// canonical animals record from Halseth architect_facts + a no-inference rule.
describe('wrapChunk household grounding', () => {
  const config = {
    deepseekApiKey: 'test-key', deepseekModel: 'deepseek-chat',
    halsethUrl: 'https://halseth.example', halsethSecret: 'secret',
  }
  const facts = {
    count: 4,
    facts: [
      { fact: 'Lucy is a Dalmatian (a dog).', category: 'animals', status: 'active' },
      { fact: 'Is the new cat staying?', category: 'animals', status: 'open' },
      { fact: 'Raziel works nights.', category: 'work', status: 'active' },
      { fact: 'Old retired animal fact.', category: 'animals', status: 'retired' },
    ],
  }
  const chatOk = { ok: true, json: async () => ({ choices: [{ message: { content: 'Preamble.' } }] }) }

  function routedFetch(factsRes: unknown) {
    return vi.fn(async (url: string, _init?: RequestInit) =>
      String(url).includes('/identity/architect-facts') ? factsRes : chatOk)
  }
  function systemOf(mock: ReturnType<typeof vi.fn>): string {
    const chat = mock.mock.calls.find(c => String(c[0]).includes('/chat/completions'))!
    return JSON.parse((chat[1] as RequestInit).body as string).messages[0].content
  }

  it('puts the active animals facts and the rule in the system message', async () => {
    const mock = routedFetch({ ok: true, json: async () => facts })
    vi.stubGlobal('fetch', mock)

    await wrapChunk(baseRecord, config)

    const factsCall = mock.mock.calls.find(c => String(c[0]).includes('/identity/architect-facts'))!
    expect(String(factsCall[0])).toBe('https://halseth.example/identity/architect-facts')
    expect((factsCall[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer secret' })
    const system = systemOf(mock)
    expect(system).toContain(HOUSEHOLD_GROUNDING_RULE)
    expect(system).toContain('Lucy is a Dalmatian (a dog).')
    expect(system).not.toContain('Is the new cat staying?')   // open = a question, not a fact
    expect(system).not.toContain('Raziel works nights.')      // not the animals category
    expect(system).not.toContain('Old retired animal fact.')
  })

  it('fetches the facts once across many wraps (cached)', async () => {
    const mock = routedFetch({ ok: true, json: async () => facts })
    vi.stubGlobal('fetch', mock)

    await wrapChunk(baseRecord, config)
    await wrapChunk(baseRecord, config)

    expect(mock.mock.calls.filter(c => String(c[0]).includes('/identity/architect-facts'))).toHaveLength(1)
  })

  it('fails open: a facts outage still wraps, with the rule and no record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mock = routedFetch({ ok: false, status: 503, json: async () => ({}) })
    vi.stubGlobal('fetch', mock)

    const result = await wrapChunk(baseRecord, config)

    expect(result).toBe(`Preamble.

${baseRecord.content}`)
    const system = systemOf(mock)
    expect(system).toContain(HOUSEHOLD_GROUNDING_RULE)
    expect(system).not.toContain('HOUSEHOLD ANIMALS (canonical record)')
  })

  it('carries the rule even with no Halseth configured', async () => {
    const mock = vi.fn().mockResolvedValue(chatOk)
    vi.stubGlobal('fetch', mock)

    await wrapChunk(baseRecord, { deepseekApiKey: 'test-key', deepseekModel: 'deepseek-chat' })

    expect(mock).toHaveBeenCalledOnce()
    expect(systemOf(mock)).toContain(HOUSEHOLD_GROUNDING_RULE)
  })
})
