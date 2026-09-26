// The gap-reader (2026-09-26, imp-lane tranche 1). Pinned: the exact deterministic body, the dedup key,
// the session source, that NO model is ever called and /companion-journal is never touched, and how a
// duplicate / 422 / 404 from /ledger is handled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./deepseek-client.js', () => ({
  chatComplete: vi.fn(async () => { throw new Error('the gap-reader must never call a model') }),
  callDeepSeek: vi.fn(async () => { throw new Error('the gap-reader must never call a model') }),
}))

import { chatComplete, callDeepSeek } from './deepseek-client.js'
import { runGapDetector, buildGapBody, sessionDate, sessionDuration, gapDedupKey, type RelationalSession } from './gap-detector.js'
import type { IngestionConfig } from './types.js'

const CONFIG = {
  halsethUrl: 'https://h.example', halsethSecret: 'sek', deepseekApiKey: 'd', deepseekModel: 'm',
} as IngestionConfig

function session(over: Partial<RelationalSession> = {}): RelationalSession {
  return {
    id: 'sess-1', session_type: 'hangout', front_state: 'Raziel', emotional_frequency: 'soft',
    notes: 'anything at all', created_at: '2026-09-26T01:00:00.000Z', updated_at: '2026-09-26T01:42:00.000Z',
    has_notes: 0, ...over,
  }
}

type Route = (url: URL, init?: RequestInit) => Response
function fakeHalseth(sessionsBy: Record<string, RelationalSession[]>, ledger: Route) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/sessions/recent-relational') {
      return new Response(JSON.stringify({ sessions: sessionsBy[url.searchParams.get('companion_id') ?? ''] ?? [] }))
    }
    if (url.pathname === '/ledger') return ledger(url, init)
    return new Response('unexpected', { status: 500 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

let errSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

describe('gap-reader pure parts', () => {
  it('body is the exact Missing: line', () => {
    expect(buildGapBody(session(), '2026-09-26'))
      .toBe('Missing: no companion note recorded for the hangout session on 2026-09-26 (42 minutes).')
  })

  it('date comes from the stamp prefix, never through local-time Date parsing (SQLite stamps have no Z)', () => {
    expect(sessionDate(session({ created_at: '2026-09-26 23:50:00' }))).toBe('2026-09-26')
    expect(sessionDate(session({ created_at: '2026-09-25T23:59:59.000Z' }))).toBe('2026-09-25')
  })

  it('duration: minutes, singular, sub-minute, zone-less stamps as UTC', () => {
    expect(sessionDuration(session({ created_at: '2026-09-26 01:00:00', updated_at: '2026-09-26 01:01:00' }))).toBe('1 minute')
    expect(sessionDuration(session({ updated_at: '2026-09-26T01:00:10.000Z' }))).toBe('under a minute')
    expect(sessionDuration(session({ created_at: 'garbage' }))).toBe('duration unknown')
  })

  it('dedup key is gap:<companion>:<session_id>', () => {
    expect(gapDedupKey('gaia', 'abc')).toBe('gap:gaia:abc')
  })

  it('the body carries none of the self-words the ledger grammar refuses', () => {
    const body = buildGapBody(session({ session_type: 'checkin' }), '2026-09-26')
    expect(body).toMatch(/^Missing:/)
    expect(body).not.toMatch(/\b(I|I'm|me|my|mine|we|us|our|felt|feel|want|wanted|your|you)\b/i)
    expect(body).not.toMatch(/[〔〕]/)
  })
})

describe('runGapDetector', () => {
  it('POSTs one gap-reader ledger entry per note-less session, with session source and dedup key', async () => {
    const { impl, calls } = fakeHalseth(
      { drevan: [session(), session({ id: 'sess-noted', has_notes: 1 })] },
      () => new Response(JSON.stringify({ id: 'led_1', content: '〔ledger · gap-reader · 2026-09-26〕 ...' }), { status: 201 }),
    )
    await runGapDetector(CONFIG, impl)
    const posts = calls.filter(c => c.url.pathname === '/ledger')
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0]!.init!.body))).toEqual({
      companion_id: 'drevan',
      function: 'gap-reader',
      body: 'Missing: no companion note recorded for the hangout session on 2026-09-26 (42 minutes).',
      source_kind: 'session',
      source_ref: 'sess-1',
      observed_on: '2026-09-26',
      dedup_key: 'gap:drevan:sess-1',
    })
  })

  it('never calls a model and never touches /companion-journal', async () => {
    const { impl, calls } = fakeHalseth(
      { drevan: [session()], cypher: [session({ id: 'c1' })], gaia: [session({ id: 'g1' })] },
      () => new Response(JSON.stringify({ id: 'x', content: 'y' }), { status: 201 }),
    )
    await runGapDetector(CONFIG, impl)
    expect(chatComplete).not.toHaveBeenCalled()
    expect(callDeepSeek).not.toHaveBeenCalled()
    expect(calls.some(c => c.url.pathname.includes('companion-journal') || c.url.pathname.includes('companion-notes'))).toBe(false)
    expect(calls.filter(c => c.url.pathname === '/ledger')).toHaveLength(3)
  })

  it('a 200 duplicate is success: no error logged', async () => {
    const { impl } = fakeHalseth({ drevan: [session()] }, () => new Response(JSON.stringify({ id: 'led_1', duplicate: true }), { status: 200 }))
    await runGapDetector(CONFIG, impl)
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a 422 is logged loudly with the rule, not retried, and the next session still runs', async () => {
    let n = 0
    const { impl, calls } = fakeHalseth({ drevan: [session(), session({ id: 'sess-2' })] }, () => {
      n++
      return n === 1
        ? new Response(JSON.stringify({ error: 'bad verb', rule: 'verbs' }), { status: 422 })
        : new Response(JSON.stringify({ id: 'led_2', content: 'z' }), { status: 201 })
    })
    await runGapDetector(CONFIG, impl)
    const posts = calls.filter(c => c.url.pathname === '/ledger')
    expect(posts.map(p => JSON.parse(String(p.init!.body)).source_ref)).toEqual(['sess-1', 'sess-2'])
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/LEDGER REJECTED drevan session sess-1: rule=verbs/)
  })

  it('a 404 (Halseth without the lane) stops the run, with no journal fallback', async () => {
    const { impl, calls } = fakeHalseth(
      { drevan: [session(), session({ id: 'sess-2' })], cypher: [session({ id: 'c1' })] },
      () => new Response('Not Found', { status: 404 }),
    )
    await runGapDetector(CONFIG, impl)
    expect(calls.filter(c => c.url.pathname === '/ledger')).toHaveLength(1)
    expect(calls.some(c => c.url.pathname.includes('companion-journal'))).toBe(false)
    expect(calls.some(c => c.url.searchParams.get('companion_id') === 'cypher')).toBe(false)
  })
})
