// The gap-reader (2026-09-26, imp-lane tranche 1). Pinned: the exact deterministic body, the dedup key,
// the session source, that NO model is ever called and /companion-journal is never touched, and how a
// duplicate / 422 / 404 from /ledger is handled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./deepseek-client.js', () => ({
  chatComplete: vi.fn(async () => { throw new Error('the gap-reader must never call a model') }),
  callDeepSeek: vi.fn(async () => { throw new Error('the gap-reader must never call a model') }),
}))

import { chatComplete, callDeepSeek } from './deepseek-client.js'
import { runGapDetector, runSomaGapReader, buildSomaGapBody, somaGapDedupKey, SOMA_STALE_MS, buildGapBody, sessionDate, sessionDuration, gapDedupKey, sessionSettled, GAP_SETTLE_MS, GAP_WINDOW_HOURS, type RelationalSession } from './gap-detector.js'
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
function fakeHalseth(sessionsBy: Record<string, RelationalSession[]>, ledger: Route, freshness: Route = () => new Response('not found', { status: 404 })) {
  const calls: Array<{ url: URL; init?: RequestInit }> = []
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    if (url.pathname === '/sessions/recent-relational') {
      return new Response(JSON.stringify({ sessions: sessionsBy[url.searchParams.get('companion_id') ?? ''] ?? [] }))
    }
    if (url.pathname === '/ledger/soma-freshness') return freshness(url, init)
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

describe('the gap-reader waits for a session to settle (review S4)', () => {
  const NOW = Date.parse('2026-09-26T05:00:00.000Z')

  it('sessionSettled: only once updated_at (else created_at) is 2h old; unparseable never', () => {
    expect(GAP_SETTLE_MS).toBe(2 * 60 * 60 * 1000)
    expect(sessionSettled(session({ updated_at: '2026-09-26T03:00:00.000Z' }), NOW)).toBe(true)
    expect(sessionSettled(session({ updated_at: '2026-09-26T03:00:01.000Z' }), NOW)).toBe(false)
    expect(sessionSettled(session({ updated_at: '2026-09-26 02:59:00' }), NOW)).toBe(true)   // SQLite stamp, UTC
    expect(sessionSettled(session({ updated_at: '', created_at: '2026-09-26T04:30:00.000Z' }), NOW)).toBe(false)
    expect(sessionSettled(session({ updated_at: 'garbage', created_at: 'garbage' }), NOW)).toBe(false)
  })

  it('a session touched under 2h ago is not read for a gap; a settled one is; the window is wide enough to hold it', async () => {
    const { impl, calls } = fakeHalseth(
      { drevan: [session({ id: 'fresh', updated_at: '2026-09-26T04:10:00.000Z' }), session({ id: 'settled', updated_at: '2026-09-26T02:40:00.000Z' })] },
      () => new Response(JSON.stringify({ id: 'led_1', content: 'x' }), { status: 201 }),
    )
    await runGapDetector(CONFIG, impl, NOW)
    const posts = calls.filter(c => c.url.pathname === '/ledger').map(c => JSON.parse(String(c.init!.body)).source_ref)
    expect(posts).toEqual(['settled'])
    const q = calls.find(c => c.url.pathname === '/sessions/recent-relational')!
    expect(Number(q.url.searchParams.get('hours'))).toBe(GAP_WINDOW_HOURS)
    expect(GAP_WINDOW_HOURS * 3600_000).toBeGreaterThan(GAP_SETTLE_MS)
  })
})

describe('SOMA staleness (Drevan 2026-09-26: stale and honest beats fresh and forged)', () => {
  const NOW = Date.parse('2026-09-27T12:00:00.000Z')
  const fresh = (companions: unknown[]) => () => new Response(JSON.stringify({ companions }))
  const ledgerPosts = (calls: Array<{ url: URL; init?: RequestInit }>) =>
    calls.filter((c) => c.url.pathname === '/ledger').map((c) => JSON.parse(String(c.init?.body)))

  it('body and dedup key shapes', () => {
    expect(buildSomaGapBody('2026-09-25T14:39:12.000Z')).toBe('Missing: SOMA not updated since 2026-09-25 14:39 UTC.')
    expect(buildSomaGapBody('2026-09-25 14:39:12')).toBe('Missing: SOMA not updated since 2026-09-25 14:39 UTC.')
    expect(buildSomaGapBody('nonsense')).toBeNull()
    expect(somaGapDedupKey('drevan', '2026-09-25T14:39:12.000Z')).toBe('soma-gap:drevan:2026-09-25T14:39:12.000Z')
  })

  it('stale (>24h): posts the exact gap-reader line with the row source', async () => {
    const { impl, calls } = fakeHalseth({}, () => new Response(JSON.stringify({ id: 'led_1', content: 'x' }), { status: 201 }), fresh([
      { companion_id: 'drevan', last_authored_at: '2026-09-25T14:39:12.000Z', row_ref: 'companion_soma_events:abc123' },
    ]))
    await runSomaGapReader(CONFIG, impl, NOW)
    expect(ledgerPosts(calls)).toEqual([{
      companion_id: 'drevan', function: 'gap-reader',
      body: 'Missing: SOMA not updated since 2026-09-25 14:39 UTC.',
      source_kind: 'row', source_ref: 'companion_soma_events:abc123',
      observed_on: '2026-09-27', dedup_key: 'soma-gap:drevan:2026-09-25T14:39:12.000Z',
    }])
  })

  it('fresh (<24h): no post', async () => {
    const recent = new Date(NOW - SOMA_STALE_MS + 60_000).toISOString()
    const { impl, calls } = fakeHalseth({}, () => new Response('{}', { status: 500 }), fresh([
      { companion_id: 'cypher', last_authored_at: recent, row_ref: 'companion_soma_events:c1' },
    ]))
    await runSomaGapReader(CONFIG, impl, NOW)
    expect(ledgerPosts(calls)).toEqual([])
  })

  it('null last_authored_at: skipped with a log, no date invented', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { impl, calls } = fakeHalseth({}, () => new Response('{}', { status: 500 }), fresh([
      { companion_id: 'gaia', last_authored_at: null, row_ref: null },
    ]))
    await runSomaGapReader(CONFIG, impl, NOW)
    expect(ledgerPosts(calls)).toEqual([])
    expect(logSpy.mock.calls.some((a) => String(a[0]).includes('gaia') && String(a[0]).includes('no authored SOMA'))).toBe(true)
  })

  it('404 from soma-freshness (Halseth not deployed): no throw, no post, no error log', async () => {
    const { impl, calls } = fakeHalseth({}, () => new Response('{}', { status: 500 }))
    await expect(runSomaGapReader(CONFIG, impl, NOW)).resolves.toBeUndefined()
    expect(ledgerPosts(calls)).toEqual([])
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('a 422 is logged with its rule and the run continues to the next companion', async () => {
    let n = 0
    const { impl, calls } = fakeHalseth({}, () => (++n === 1
      ? new Response(JSON.stringify({ error: 'no', rule: 'health' }), { status: 422 })
      : new Response(JSON.stringify({ id: 'led_2', content: 'x' }), { status: 201 })), fresh([
      { companion_id: 'drevan', last_authored_at: '2026-09-20T01:00:00.000Z', row_ref: 'companion_soma_events:d1' },
      { companion_id: 'cypher', last_authored_at: '2026-09-21T01:00:00.000Z', row_ref: 'companion_soma_events:c1' },
    ]))
    await runSomaGapReader(CONFIG, impl, NOW)
    expect(ledgerPosts(calls).map((p) => p.companion_id)).toEqual(['drevan', 'cypher'])
    expect(errSpy.mock.calls.some((a: unknown[]) => String(a[0]).includes('rule=health'))).toBe(true)
  })

  it('runGapDetector rides the same cadence: it calls soma-freshness after the session check', async () => {
    const { impl, calls } = fakeHalseth({}, () => new Response('{}', { status: 500 }))
    await runGapDetector(CONFIG, impl, NOW)
    expect(calls.some((c) => c.url.pathname === '/ledger/soma-freshness')).toBe(true)
  })
})
