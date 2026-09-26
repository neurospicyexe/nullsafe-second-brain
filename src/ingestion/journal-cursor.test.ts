// Halseth tray pass 2 (2026-09-26): the companion_journal feed advances on when a row became MEMORY.
//
// A draft created last week and kept today has created_at far behind the mark; with a created_at
// cursor it was never pulled and the vault never learned it was kept. The puller now asks for
// `cursor=reviewed`, halseth returns `cursor_at` (= COALESCE(reviewed_at, created_at), normalised
// ISO), and the pipeline advances on it. Both directions of version skew stay safe:
//   - new SB + old halseth: the param is ignored, no cursor_at comes back, the mark uses created_at.
//   - old SB + new halseth: the param is never sent, so halseth serves the old created_at feed.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { pullCompanionJournal } from './puller.js'
import { hwmAfter } from './pipeline.js'
import type { IngestionConfig, IngestRecord } from './types.js'

const CONFIG = {
  halsethUrl: 'https://halseth.example.com',
  halsethSecret: 'test-secret',
} as IngestionConfig

afterEach(() => { vi.restoreAllMocks() })

function mockFetch(body: unknown) {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  return calls
}

describe('pullCompanionJournal', () => {
  it('asks for cursor=reviewed and carries cursor_at as the record cursor (not into the vault content)', async () => {
    const calls = mockFetch([
      { id: 'kept-later', agent: 'cypher', note_text: 'x', created_at: '2026-09-21T10:00:00.000Z', review_state: 'kept', reviewed_at: '2026-09-26T08:00:00.000Z', cursor_at: '2026-09-26T08:00:00.000Z' },
    ])
    const { records, error } = await pullCompanionJournal(CONFIG, '2026-09-25T00:00:00.000Z')
    expect(error).toBeUndefined()
    const url = new URL(calls[0]!)
    expect(url.pathname).toBe('/companion-journal')
    expect(url.searchParams.get('cursor')).toBe('reviewed')
    expect(url.searchParams.get('since')).toBe('2026-09-25T00:00:00.000Z')
    expect(records[0]!.cursor).toBe('2026-09-26T08:00:00.000Z')
    expect(records[0]!.created_at).toBe('2026-09-21T10:00:00.000Z')
    expect(JSON.parse(records[0]!.content)).not.toHaveProperty('cursor_at')
    expect(JSON.parse(records[0]!.content)).toMatchObject({ id: 'kept-later', reviewed_at: '2026-09-26T08:00:00.000Z' })
  })

  it('an older halseth (no cursor_at) yields records with no cursor: the mark falls back to created_at', async () => {
    mockFetch([{ id: 'j1', agent: 'gaia', note_text: 'y', created_at: '2026-09-26T01:00:00.000Z' }])
    const { records } = await pullCompanionJournal(CONFIG, undefined)
    expect(records[0]!.cursor).toBeUndefined()
    expect(hwmAfter('2026-09-25T00:00:00.000Z', records[0]!)).toBe('2026-09-26T01:00:00.000Z')
  })
})

describe('hwmAfter', () => {
  const rec = (created_at: string, cursor?: string): IngestRecord =>
    ({ id: 1, source_type: 'companion_journal', content: '{}', created_at, ...(cursor ? { cursor } : {}) })

  it('prefers the cursor', () => {
    expect(hwmAfter('2026-09-25T00:00:00.000Z', rec('2026-09-21T00:00:00.000Z', '2026-09-26T00:00:00.000Z'))).toBe('2026-09-26T00:00:00.000Z')
  })
  it('never moves backward or sideways', () => {
    expect(hwmAfter('2026-09-25T00:00:00.000Z', rec('2026-09-21T00:00:00.000Z'))).toBeNull()
    expect(hwmAfter('2026-09-25T00:00:00.000Z', rec('2026-09-25T00:00:00.000Z'))).toBeNull()
  })
  it('starts the mark when there is none', () => {
    expect(hwmAfter(undefined, rec('2026-09-21T00:00:00.000Z'))).toBe('2026-09-21T00:00:00.000Z')
  })
})
