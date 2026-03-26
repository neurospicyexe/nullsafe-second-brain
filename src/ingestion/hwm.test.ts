import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { loadHwm, saveHwm, getHwm, setHwm } from './hwm.js'

function tempHwmPath(): string {
  return path.join(os.tmpdir(), `hwm-test-${Math.random().toString(36).slice(2)}.json`)
}

describe('loadHwm', () => {
  it('returns empty object for non-existent file', () => {
    const result = loadHwm('/nonexistent/path/that/does/not/exist/hwm.json')
    expect(result).toEqual({})
  })
})

describe('saveHwm + loadHwm', () => {
  it('round-trips correctly', () => {
    const p = tempHwmPath()
    try {
      const hwm = { synthesis_summary: '2026-01-01T00:00:00.000Z', feeling: '2026-02-15T12:00:00.000Z' }
      saveHwm(p, hwm)
      const loaded = loadHwm(p)
      expect(loaded).toEqual(hwm)
    } finally {
      fs.rmSync(p, { force: true })
    }
  })

  it('creates parent directory if missing', () => {
    const dir = path.join(os.tmpdir(), `hwm-dir-${Math.random().toString(36).slice(2)}`)
    const p = path.join(dir, 'nested', 'hwm.json')
    try {
      saveHwm(p, { handoff: '2026-03-01T00:00:00.000Z' })
      expect(fs.existsSync(p)).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('getHwm', () => {
  it('returns undefined for missing key', () => {
    expect(getHwm({}, 'synthesis_summary')).toBeUndefined()
  })

  it('returns value for existing key', () => {
    const hwm = { synthesis_summary: '2026-01-01T00:00:00.000Z' }
    expect(getHwm(hwm, 'synthesis_summary')).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('setHwm', () => {
  it('returns new object with updated key', () => {
    const original = { synthesis_summary: '2026-01-01T00:00:00.000Z' }
    const updated = setHwm(original, 'synthesis_summary', '2026-03-01T00:00:00.000Z')
    expect(updated.synthesis_summary).toBe('2026-03-01T00:00:00.000Z')
  })

  it('does not mutate the original', () => {
    const original = { synthesis_summary: '2026-01-01T00:00:00.000Z' }
    setHwm(original, 'synthesis_summary', '2026-03-01T00:00:00.000Z')
    expect(original.synthesis_summary).toBe('2026-01-01T00:00:00.000Z')
  })

  it('adds new key without touching existing keys', () => {
    const original = { synthesis_summary: '2026-01-01T00:00:00.000Z' }
    const updated = setHwm(original, 'feeling', '2026-02-01T00:00:00.000Z')
    expect(updated.synthesis_summary).toBe('2026-01-01T00:00:00.000Z')
    expect(updated.feeling).toBe('2026-02-01T00:00:00.000Z')
  })
})
