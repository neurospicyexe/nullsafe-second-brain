import { describe, it, expect } from 'vitest'
import { extractTags } from './pipeline.js'
import type { IngestRecord } from './types.js'

function record(content: Record<string, unknown>): IngestRecord {
  return {
    id: 1,
    source_type: 'companion_journal',
    content: JSON.stringify(content),
    created_at: new Date(0).toISOString(),
  }
}

describe('extractTags', () => {
  it('merges tags and topic_tags from a companion_journal row', () => {
    const rec = record({ tags: '["projects","people"]', topic_tags: '["babita"]' })
    expect(extractTags(rec)).toEqual(['projects', 'people', 'babita'])
  })

  it('dedupes overlapping values across keys', () => {
    const rec = record({ tags: '["projects"]', topic_tags: '["projects","babita"]' })
    expect(extractTags(rec)).toEqual(['projects', 'babita'])
  })

  it('returns empty array when tags fields are null', () => {
    const rec = record({ tags: null, topic_tags: null })
    expect(extractTags(rec)).toEqual([])
  })

  it('returns empty array when tags fields are absent', () => {
    const rec = record({ note_text: 'no tags here' })
    expect(extractTags(rec)).toEqual([])
  })

  it('ignores malformed JSON in a tags field without throwing', () => {
    const rec = record({ tags: 'not-json-array' })
    expect(extractTags(rec)).toEqual([])
  })

  it('returns empty array for non-JSON content', () => {
    const rec: IngestRecord = { id: 1, source_type: 'companion_journal', content: 'plain text', created_at: new Date(0).toISOString() }
    expect(extractTags(rec)).toEqual([])
  })
})
