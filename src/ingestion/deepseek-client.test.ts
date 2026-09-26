// DeepInfra-first vendor chain for every Second Brain ingestion call (2026-09-26).
//
// Raziel's rule: all DeepSeek-model inference goes through DeepInfra; the direct DeepSeek
// platform is a ~$10 emergency lane, used only when DeepInfra fails, and loudly. The legacy
// VPS alias (DEEPSEEK_BASE_URL=api.deepinfra.com, so DEEPSEEK_API_KEY holds a DeepInfra key)
// must keep working and must NEVER send that key to api.deepseek.com.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  resolveVendors, chatComplete, resetVendorWarnings, wireMaxTokens,
  DEEPINFRA_FLASH_MODEL, DEEPSEEK_DIRECT_MODEL, FELL_BACK_TAG, REASONING_HEADROOM,
} from './deepseek-client.js'
import { wrapChunk } from './deepseek-wrapper.js'
import { semanticChunk } from './chunker.js'

const DI = 'https://api.deepinfra.com/v1/openai/chat/completions'
const DS = 'https://api.deepseek.com/chat/completions'

function ok(content: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }), text: async () => '' }
}
function fail(status: number) {
  return { ok: false, status, json: async () => ({}), text: async () => 'nope' }
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const urls = (fn: { mock: { calls: any[][] } }) => fn.mock.calls.map((c) => String(c[0]))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const auth = (fn: { mock: { calls: any[][] } }, i: number) => (fn.mock.calls[i]![1].headers as Record<string, string>).Authorization
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (fn: { mock: { calls: any[][] } }, i: number) => JSON.parse(String(fn.mock.calls[i]![1].body))

let warn: ReturnType<typeof vi.spyOn>
const warnLines = (): string[] => (warn.mock.calls as unknown[][]).map((c) => String(c[0]))
beforeEach(() => {
  resetVendorWarnings()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('resolveVendors', () => {
  it('DeepInfra primary, direct DeepSeek fallback, per-vendor model ids', () => {
    const chain = resolveVendors({ deepseekApiKey: 'ds', deepseekModel: 'deepseek-v4-flash' }, { DEEPINFRA_API_KEY: 'di' })
    expect(chain.map((v) => [v.label, v.apiKey, v.model])).toEqual([
      ['DeepInfra', 'di', DEEPINFRA_FLASH_MODEL],
      ['DeepSeek', 'ds', DEEPSEEK_DIRECT_MODEL],
    ])
    expect(chain[1]!.baseUrl).toBe('https://api.deepseek.com')
  })

  it('LEGACY alias (live VPS shape): DeepInfra base URL + no DEEPINFRA key => the key goes to DeepInfra only', () => {
    const chain = resolveVendors(
      { deepseekApiKey: 'actually-a-deepinfra-key', deepseekModel: DEEPINFRA_FLASH_MODEL },
      { DEEPSEEK_BASE_URL: 'https://api.deepinfra.com/v1/openai' },
    )
    expect(chain).toHaveLength(1)
    expect(chain[0]).toMatchObject({ label: 'DeepInfra', apiKey: 'actually-a-deepinfra-key', model: DEEPINFRA_FLASH_MODEL })
    expect(chain[0]!.baseUrl).toMatch(/deepinfra/)
    expect(warnLines().some((l) => l.includes('DEEPINFRA_API_KEY absent'))).toBe(true)
  })

  it('both keys but DEEPSEEK_BASE_URL still DeepInfra => fallback NOT armed (key may be a DeepInfra key)', () => {
    const chain = resolveVendors({ deepseekApiKey: 'x' }, { DEEPINFRA_API_KEY: 'di', DEEPSEEK_BASE_URL: 'https://api.deepinfra.com/v1/openai' })
    expect(chain.map((v) => v.label)).toEqual(['DeepInfra'])
  })

  it('DeepSeek-only when no DeepInfra key anywhere, with a warning; delisted model id mapped to flash', () => {
    const chain = resolveVendors({ deepseekApiKey: 'ds', deepseekModel: 'deepseek-chat' }, {})
    expect(chain.map((v) => [v.label, v.model])).toEqual([['DeepSeek', DEEPSEEK_DIRECT_MODEL]])
    expect(warnLines().some((l) => l.includes('direct DeepSeek ONLY'))).toBe(true)
  })

  it('DeepInfra-only when only DEEPINFRA_API_KEY is set; empty when nothing is', () => {
    expect(resolveVendors({ deepseekApiKey: '' }, { DEEPINFRA_API_KEY: 'di' }).map((v) => v.label)).toEqual(['DeepInfra'])
    expect(resolveVendors({}, {})).toEqual([])
  })

  it('adds reasoning headroom for DeepSeek models on both vendors', () => {
    expect(wireMaxTokens(120, DEEPINFRA_FLASH_MODEL)).toBe(120 + REASONING_HEADROOM)
    expect(wireMaxTokens(120, DEEPSEEK_DIRECT_MODEL)).toBe(120 + REASONING_HEADROOM)
  })
})

describe('chatComplete', () => {
  const env = { DEEPINFRA_API_KEY: 'di' }
  const cfg = { deepseekApiKey: 'ds', deepseekModel: 'deepseek-v4-flash' }
  const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 100, temperature: 0.2, caller: 't' }

  it('never calls DeepSeek when DeepInfra answers', async () => {
    const fn = vi.fn(async () => ok('fine'))
    vi.stubGlobal('fetch', fn)
    const r = await chatComplete(req, cfg, env)
    expect(r).toMatchObject({ ok: true, content: 'fine', vendor: 'DeepInfra' })
    expect(urls(fn)).toEqual([DI])
    expect(auth(fn, 0)).toBe('Bearer di')
    expect(warnLines().some((l) => l.includes(FELL_BACK_TAG))).toBe(false)
  })

  it('falls back to DeepSeek on a DeepInfra 402/5xx and logs the FELL BACK line', async () => {
    const fn = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok('rescued'))
    vi.stubGlobal('fetch', fn)
    const r = await chatComplete(req, cfg, env)
    expect(r).toMatchObject({ ok: true, content: 'rescued', vendor: 'DeepSeek' })
    expect(urls(fn)).toEqual([DI, DS])
    expect(auth(fn, 1)).toBe('Bearer ds')
    expect(body(fn, 1).model).toBe(DEEPSEEK_DIRECT_MODEL)
    const line = warnLines().find((l) => l.includes(FELL_BACK_TAG))
    expect(line).toContain('HTTP 503')
    expect(line).toContain('caller=t')
  })

  it('falls back on a network error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(ok('rescued'))
    vi.stubGlobal('fetch', fn)
    expect(await chatComplete(req, cfg, env)).toMatchObject({ ok: true, vendor: 'DeepSeek' })
  })

  it('does NOT spend the emergency lane on a 400 or an empty 200', async () => {
    let fn = vi.fn(async () => fail(400))
    vi.stubGlobal('fetch', fn)
    expect(await chatComplete(req, cfg, env)).toMatchObject({ ok: false, status: 400 })
    expect(urls(fn)).toEqual([DI])

    fn = vi.fn(async () => ok(''))
    vi.stubGlobal('fetch', fn)
    expect(await chatComplete(req, cfg, env)).toMatchObject({ ok: true, content: '' })
    expect(urls(fn)).toEqual([DI])
  })

  it('reports the last failure when every vendor fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(402)))
    expect(await chatComplete(req, cfg, env)).toMatchObject({ ok: false, status: 402 })
  })
})

describe('callers ride the chain', () => {
  const record = {
    source_type: 'journal', companion_id: 'cypher', content: 'body', created_at: '2026-09-26', thread_key: null,
  } as unknown as Parameters<typeof wrapChunk>[0]

  it('wrapChunk goes to DeepInfra first when DEEPINFRA_API_KEY is set', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'di')
    const fn = vi.fn(async () => ok('A preamble.'))
    vi.stubGlobal('fetch', fn)
    await expect(wrapChunk(record, { deepseekApiKey: 'ds', deepseekModel: 'deepseek-v4-flash' })).resolves.toContain('A preamble.')
    expect(urls(fn)).toEqual([DI])
  })

  it('semanticChunk falls back to DeepSeek when DeepInfra 429s', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'di')
    const fn = vi.fn().mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok('[{"label":"a","content":"b"}]'))
    vi.stubGlobal('fetch', fn)
    const chunks = await semanticChunk('text', { deepseekApiKey: 'ds', deepseekModel: 'deepseek-v4-flash' })
    expect(chunks).toEqual([{ label: 'a', content: 'b' }])
    expect(urls(fn)).toEqual([DI, DS])
  })
})
