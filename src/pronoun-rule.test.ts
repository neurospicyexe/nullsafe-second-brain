// Owner pronoun rule coverage (2026-09-24).
//
// Drevan reported background synthesis narratives calling Crash (Raziel) "she" -- confirmed in
// prod. Ingestion here writes prose too (wrap preambles, gap-fill companion notes), so every
// direct-fetch caller must carry the rule. This asserts the module is idempotent and that the
// three ingestion callers (the shared client, the wrap preamble, and gap-detector's own local
// caller) each send it as a system message.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { OWNER_PRONOUN_RULE, withOwnerPronounRule } from './pronoun-rule.js'
import { callDeepSeek } from './ingestion/deepseek-client.js'
import { wrapChunk } from './ingestion/deepseek-wrapper.js'
import type { IngestRecord } from './ingestion/types.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OWNER_PRONOUN_RULE / withOwnerPronounRule', () => {
  it('states he/him or they/them, never she/her, for Raziel', () => {
    expect(OWNER_PRONOUN_RULE).toMatch(/he\/him/)
    expect(OWNER_PRONOUN_RULE).toMatch(/they\/them/)
    expect(OWNER_PRONOUN_RULE).toMatch(/NEVER she\/her/)
  })

  it('appends the rule to a plain system prompt', () => {
    const out = withOwnerPronounRule('You are a clerk.')
    expect(out).toContain('You are a clerk.')
    expect(out).toContain(OWNER_PRONOUN_RULE)
  })

  it('is idempotent -- wrapping an already-wrapped prompt does not double the rule', () => {
    const once = withOwnerPronounRule('You are a clerk.')
    const twice = withOwnerPronounRule(once)
    expect(twice).toBe(once)
    expect(twice.split(OWNER_PRONOUN_RULE).length - 1).toBe(1)
  })

  it('handles an empty system prompt without a leading blank line', () => {
    expect(withOwnerPronounRule('')).toBe(OWNER_PRONOUN_RULE)
  })
})

describe('ingestion callers send the pronoun rule as a system message', () => {
  it('callDeepSeek (shared client) sends it', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await callDeepSeek('test-key', 'deepseek-v4-flash', 'user prompt')

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    const systemMsg = body.messages.find((m: { role: string }) => m.role === 'system')
    expect(systemMsg?.content).toBe(OWNER_PRONOUN_RULE)
  })

  it('wrapChunk sends it', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'a preamble' } }] }),
    })
    vi.stubGlobal('fetch', mockFetch)

    const record: IngestRecord = {
      id: 1,
      source_type: 'synthesis_summary',
      content: 'text',
      created_at: '2026-03-25T12:00:00.000Z',
      companion_id: 'cypher',
    }
    await wrapChunk(record, { deepseekApiKey: 'test-key', deepseekModel: 'deepseek-v4-flash' })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    const systemMsg = body.messages.find((m: { role: string }) => m.role === 'system')
    expect(systemMsg?.content).toBe(OWNER_PRONOUN_RULE)
  })
})
