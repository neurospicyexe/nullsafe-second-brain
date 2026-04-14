import { describe, it, expect } from 'vitest'
import * as mod from './pattern-synthesizer.js'

describe('signal audit prompt content', () => {
  it('runSignalAudit is exported', () => {
    expect(typeof mod.runSignalAudit).toBe('function')
  })
})
