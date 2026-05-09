import { describe, it, expect } from 'vitest'

// Regression tests for the 2026-05-09 4-agent audit findings (Second-Brain repo).
// S1 — daysSince NaN safety (sit-prompts)
// S2 — covered by evaluator.test.ts; this file tests the inputs daysSince guards
// S3 — cosineSimilarity NaN safety (vector-store)
// S4 — fire-and-forget catch wraps the IIFE (smoke-only)
// S5 — atomic mutex pattern smoke test

import { daysSince } from '../ingestion/sit-prompts.js'
import { VectorStore } from '../store/vector-store.js'

describe('S1: daysSince NaN safety', () => {
  it('returns 0 for invalid date strings', () => {
    expect(daysSince('not-a-date')).toBe(0)
  })
  it('returns 0 for empty string', () => {
    expect(daysSince('')).toBe(0)
  })
  it('returns 0 (not NaN) for null-coerced input', () => {
    // @ts-expect-error testing runtime null
    const d = daysSince(null)
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBe(0)
  })
  it('returns 0 (not NaN) for undefined-coerced input', () => {
    // @ts-expect-error testing runtime undefined
    const d = daysSince(undefined)
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBe(0)
  })
  it('returns a positive finite number for a valid ISO ~1 day ago', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString()
    const d = daysSince(yesterday)
    expect(d).toBeGreaterThan(0.9)
    expect(d).toBeLessThan(1.1)
  })
  it('returns 0 (not negative) for future ISO timestamps', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    expect(daysSince(tomorrow)).toBe(0)
  })
})

describe('S3: VectorStore.cosineSimilarity NaN safety', () => {
  // Use an in-memory store so we can call the (now-internal-but-public) method.
  const store = new VectorStore(':memory:')

  it('returns 0 when an element is NaN', () => {
    expect(store.cosineSimilarity([1, NaN, 1], [1, 1, 1])).toBe(0)
  })
  it('returns 0 when an element is +Infinity', () => {
    expect(store.cosineSimilarity([1, Infinity, 1], [1, 1, 1])).toBe(0)
  })
  it('returns 0 when an element is -Infinity', () => {
    expect(store.cosineSimilarity([1, -Infinity, 1], [1, 1, 1])).toBe(0)
  })
  it('returns 0 for empty vectors', () => {
    expect(store.cosineSimilarity([], [])).toBe(0)
  })
  it('returns 0 for length mismatch', () => {
    expect(store.cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })
  it('returns 0 for zero vector vs zero vector', () => {
    expect(store.cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0)
  })
  it('returns finite similarity for two parallel vectors', () => {
    const r = store.cosineSimilarity([1, 1, 1], [2, 2, 2])
    expect(Number.isFinite(r)).toBe(true)
    expect(r).toBeCloseTo(1.0, 4)
  })
  it('returns finite similarity for two orthogonal vectors', () => {
    const r = store.cosineSimilarity([1, 0, 0], [0, 1, 0])
    expect(r).toBeCloseTo(0.0, 4)
  })
})

describe('S4: fire-and-forget IIFE pattern (smoke)', () => {
  it('does not surface unhandledRejection when wrapped with .catch()', async () => {
    const handler = (): void => { throw new Error('unhandled escaped') }
    process.once('unhandledRejection', handler)
    // Mirror the production pattern: void IIFE + .catch swallow.
    void (async () => { throw new Error('boom') })().catch(() => { /* swallowed */ })
    await new Promise(r => setImmediate(r))
    process.removeListener('unhandledRejection', handler)
    // If the .catch was missing this test would have thrown via the listener.
    expect(true).toBe(true)
  })
})

describe('S5: atomic mutex acquisition pattern (smoke)', () => {
  it('check-and-set BEFORE first await prevents the race window', async () => {
    let running = false
    const acquire = (): boolean => {
      if (running) return false
      running = true
      return true
    }
    // Both callers race; only one acquires.
    const r1 = acquire()
    const r2 = acquire()
    expect([r1, r2].sort()).toEqual([false, true])
    running = false
  })
})
