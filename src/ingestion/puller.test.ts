import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildUrl, pullSynthesisSummaries } from './puller.js'
import type { IngestionConfig } from './types.js'

const BASE_CONFIG: IngestionConfig = {
  halsethUrl: 'https://halseth.example.com',
  halsethSecret: 'test-secret',
  deepseekApiKey: 'sk-test',
  deepseekModel: 'deepseek-chat',
  cronSchedule: '*/20 * * * *',
  concurrencyLimit: 3,
  concurrencyDelayMs: 500,
  embeddingBatchSize: 20,
  hwmPath: '/tmp/hwm.json',
  evaluatorCronSchedule: '0 */6 * * *',
  sitPromptCronSchedule: '0 */12 * * *',
}

// ---- buildUrl ----

describe('buildUrl', () => {
  it('adds since and limit when both provided', () => {
    const url = buildUrl('https://halseth.example.com', '/ingest/synthesis-summaries', '2026-01-01T00:00:00.000Z', 50)
    const parsed = new URL(url)
    expect(parsed.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.searchParams.get('limit')).toBe('50')
    expect(parsed.pathname).toBe('/ingest/synthesis-summaries')
  })

  it('adds only limit when since is undefined', () => {
    const url = buildUrl('https://halseth.example.com', '/ingest/synthesis-summaries', undefined, 100)
    const parsed = new URL(url)
    expect(parsed.searchParams.has('since')).toBe(false)
    expect(parsed.searchParams.get('limit')).toBe('100')
  })

  it('defaults limit to 100 when not provided', () => {
    const url = buildUrl('https://halseth.example.com', '/deltas')
    const parsed = new URL(url)
    expect(parsed.searchParams.get('limit')).toBe('100')
  })
})

// ---- pullSynthesisSummaries ----

const MOCK_SUMMARIES = [
  {
    id: 1,
    companion_id: 'cypher',
    summary_type: 'session',
    content: 'Session went well.',
    thread_key: 'thread-abc',
    created_at: '2026-03-20T12:00:00.000Z',
  },
  {
    id: 2,
    companion_id: 'drevan',
    summary_type: 'topic',
    content: 'Deep dive on spiral.',
    thread_key: undefined,
    created_at: '2026-03-21T08:00:00.000Z',
  },
]

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pullSynthesisSummaries', () => {
  it('returns normalized IngestRecord array with correct source_type', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SUMMARIES,
    }))

    const result = await pullSynthesisSummaries(BASE_CONFIG, '2026-03-01T00:00:00.000Z')

    expect(result.error).toBeUndefined()
    expect(result.records).toHaveLength(2)

    const [first, second] = result.records
    expect(first.source_type).toBe('synthesis_summary')
    expect(first.id).toBe(1)
    expect(first.companion_id).toBe('cypher')
    expect(first.thread_key).toBe('thread-abc')
    expect(first.created_at).toBe('2026-03-20T12:00:00.000Z')
    // content is the raw record JSON-stringified
    expect(JSON.parse(first.content)).toMatchObject({ id: 1, companion_id: 'cypher' })

    expect(second.source_type).toBe('synthesis_summary')
    expect(second.companion_id).toBe('drevan')
    expect(second.thread_key).toBeUndefined()
  })

  it('passes since param to fetch URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    })
    vi.stubGlobal('fetch', mockFetch)

    await pullSynthesisSummaries(BASE_CONFIG, '2026-02-15T00:00:00.000Z')

    const calledUrl: string = mockFetch.mock.calls[0][0] as string
    expect(calledUrl).toContain('since=2026-02-15T00%3A00%3A00.000Z')
  })

  it('returns { records: [], error } when fetch fails (non-ok response)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    }))

    const result = await pullSynthesisSummaries(BASE_CONFIG)

    expect(result.records).toEqual([])
    expect(result.error).toMatch(/503/)
  })

  it('returns { records: [], error } when fetch throws (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    const result = await pullSynthesisSummaries(BASE_CONFIG)

    expect(result.records).toEqual([])
    expect(result.error).toBe('ECONNREFUSED')
  })

  it('handles { items: [] } response shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: MOCK_SUMMARIES }),
    }))

    const result = await pullSynthesisSummaries(BASE_CONFIG)

    expect(result.records).toHaveLength(2)
    expect(result.error).toBeUndefined()
  })
})
