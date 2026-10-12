import { describe, expect, it } from 'vitest'
import { cashVarianceTone, stockVarianceTone } from './day-close'

describe('variance tones (prototype thresholds)', () => {
  it('cash', () => {
    expect(cashVarianceTone(0)).toBe('balanced')
    expect(cashVarianceTone(0.001)).toBe('balanced')
    expect(cashVarianceTone(-49.99)).toBe('minor')
    expect(cashVarianceTone(50)).toBe('major')
  })
  it('station stock', () => {
    expect(stockVarianceTone(0, 100)).toBe('balanced')
    expect(stockVarianceTone(-9.999, 5)).toBe('minor')
    expect(stockVarianceTone(12, 1000)).toBe('minor')
    expect(stockVarianceTone(12, 100)).toBe('major')
  })
})
