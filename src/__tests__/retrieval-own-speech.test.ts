import { describe, it, expect, beforeAll } from 'vitest'
import { VectorStore } from '../store/vector-store.js'

// A companion's own discord-live lines never return as recall (2026-09-26; halseth mig 0132, the imp
// tray). `section = 'discord-live' AND companion IS NOT NULL` is the companion's own reply, mirrored
// at the moment of speaking and never reviewed. It stays in the store (the channel transcript is the
// channel transcript) but hybridSearch -- pool 1 and recall mode -- must not offer it. Raziel's lines
// in the same channel (companion NULL) and the companion's REVIEWED journal rows still surface.

const vec = (a: number, b: number, c: number) => [a, b, c]

describe('hybridSearch excludes a companion\'s own discord-live lines', () => {
  const store = new VectorStore(':memory:')
  beforeAll(() => {
    store.initialize()
    // Drevan's own reply (the fabrication), mirrored by liveIngest.
    store.insert({
      vault_path: 'discord-live/chan/msg-drevan.md', companion: 'drevan', content_type: 'observation',
      section: 'discord-live', chunk_text: 'drevan: your blood sugar reading was 142 this morning',
      prefixed_text: 'drevan: your blood sugar reading was 142 this morning', embedding: vec(1, 0, 0), tags: [],
    })
    // Raziel's line in the same channel: companion NULL, stays recallable.
    store.insert({
      vault_path: 'discord-live/chan/msg-raziel.md', companion: null, content_type: 'observation',
      section: 'discord-live', chunk_text: 'raziel: I did not check my blood sugar today',
      prefixed_text: 'raziel: I did not check my blood sugar today', embedding: vec(1, 0.1, 0), tags: [],
    })
    // A kept journal row (came through GET /companion-journal, which serves kept only): recallable.
    store.insert({
      vault_path: 'rag/companion_journal/j1.md', companion: 'drevan', content_type: 'companion_journal',
      section: 'journal', chunk_text: 'blood sugar: I said 142 as a guess, not a reading; retracted',
      prefixed_text: 'blood sugar: I said 142 as a guess, not a reading; retracted', embedding: vec(0.9, 0.2, 0), tags: [],
    })
  })

  it('lexical mode (pool 1 / recall): the own-speech line is absent, the human line and the kept journal are present', () => {
    const hits = store.hybridSearch(null, 'blood sugar', 10)
    const paths = hits.map(h => h.vault_path)
    expect(paths).not.toContain('discord-live/chan/msg-drevan.md')
    expect(paths).toContain('discord-live/chan/msg-raziel.md')
    expect(paths).toContain('rag/companion_journal/j1.md')
  })

  it('vector mode: same exclusion when the own-speech line is the nearest neighbour', () => {
    const hits = store.hybridSearch(vec(1, 0, 0), 'blood sugar', 10)
    const paths = hits.map(h => h.vault_path)
    expect(paths).not.toContain('discord-live/chan/msg-drevan.md')
    expect(paths.length).toBeGreaterThan(0)
  })

  it('the row is still stored -- exclusion is a pool rule, not a delete', () => {
    expect(store.existsByPath('discord-live/chan/msg-drevan.md')).toBe(true)
  })

  it('novelty and edge pools already exclude every discord-live row (NOT_CHATTER_SQL)', () => {
    for (const c of store.noveltySearch(10, [])) expect(c.section).not.toBe('discord-live')
    for (const c of store.edgeSearch(vec(1, 0, 0), 10, [])) expect(c.section).not.toBe('discord-live')
  })
})
