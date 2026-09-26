// ledger-client (2026-09-26, imp-lane tranche 1): the status matrix of POST /ledger, pinned once so the
// gap-reader and the drift evaluator can rely on the same five outcomes.
import { describe, it, expect, vi } from 'vitest'
import { postLedger, type LedgerEntry } from './ledger-client.js'

const CFG = { halsethUrl: 'https://h.example', halsethSecret: 'sek' }
const ENTRY: LedgerEntry = {
  companion_id: 'drevan', function: 'gap-reader',
  body: 'Missing: no companion note recorded for the hangout session on 2026-09-26 (40 minutes).',
  source_kind: 'session', source_ref: 's1', observed_on: '2026-09-26', dedup_key: 'gap:drevan:s1',
}

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) as unknown as typeof fetch
}

describe('postLedger', () => {
  it('POSTs the entry as-is to /ledger with admin auth (no mark, no source tail: Halseth stamps those)', async () => {
    const f = respond(201, { id: 'led_1', content: '〔ledger · gap-reader · 2026-09-26〕 Missing: ...' })
    await postLedger(CFG, ENTRY, f)
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toBe('https://h.example/ledger')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sek')
    const sent = JSON.parse(init.body)
    expect(sent).toEqual(ENTRY)
    expect(sent.body).not.toContain('〔')
  })

  it('201 -> written with id + content', async () => {
    expect(await postLedger(CFG, ENTRY, respond(201, { id: 'led_1', content: '〔ledger · x〕 y' })))
      .toEqual({ kind: 'written', id: 'led_1', content: '〔ledger · x〕 y' })
  })

  it('200 duplicate -> duplicate (success, not an error)', async () => {
    expect(await postLedger(CFG, ENTRY, respond(200, { id: 'led_1', duplicate: true })))
      .toEqual({ kind: 'duplicate', id: 'led_1' })
  })

  it('422 -> rejected, naming the rule', async () => {
    expect(await postLedger(CFG, ENTRY, respond(422, { error: 'first person', rule: 'no_self' })))
      .toEqual({ kind: 'rejected', error: 'first person', rule: 'no_self' })
  })

  it('404 -> unavailable (Halseth predates the lane)', async () => {
    expect(await postLedger(CFG, ENTRY, respond(404, 'Not Found'))).toEqual({ kind: 'unavailable' })
  })

  it('5xx and network failures -> error, never a throw', async () => {
    expect(await postLedger(CFG, ENTRY, respond(500, 'boom'))).toMatchObject({ kind: 'error', status: 500 })
    const thrower = vi.fn(async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await postLedger(CFG, ENTRY, thrower)).toEqual({ kind: 'error', message: 'ECONNRESET' })
  })
})
