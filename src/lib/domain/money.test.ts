import { describe, expect, it } from 'vitest'
import { formatMinorUnits, previewVatExclusive, previewVatInclusive, toMinorUnits } from './money'

describe('toMinorUnits', () => {
  it('parses whole and fractional amounts without float drift', () => {
    expect(toMinorUnits('12')).toBe(1200)
    expect(toMinorUnits('12.5')).toBe(1250)
    expect(toMinorUnits('0.07')).toBe(7)
    expect(toMinorUnits('19.99')).toBe(1999)
    expect(toMinorUnits('-3.10')).toBe(-310)
  })
  it('rejects malformed input', () => {
    expect(() => toMinorUnits('abc')).toThrow(RangeError)
    expect(() => toMinorUnits('1.234')).toThrow(RangeError)
    expect(() => toMinorUnits('')).toThrow(RangeError)
  })
})

describe('formatMinorUnits', () => {
  it('formats with two decimals and Arabic numerals', () => {
    expect(formatMinorUnits(125050)).toBe('1250.50')
    expect(formatMinorUnits(5)).toBe('0.05')
    expect(formatMinorUnits(-310)).toBe('-3.10')
  })
  it('rejects non-integers', () => {
    expect(() => formatMinorUnits(1.5)).toThrow(RangeError)
  })
})

describe('previewVatExclusive', () => {
  it('adds 15% VAT', () => {
    expect(previewVatExclusive(10000, 1500)).toEqual({ net: 10000, vat: 1500, gross: 11500 })
  })
  it('rounds half away from zero and keeps net + vat = gross', () => {
    const p = previewVatExclusive(1999, 1500) // 299.85 -> 300
    expect(p.vat).toBe(300)
    expect(p.net + p.vat).toBe(p.gross)
  })
  it('supports zero rate', () => {
    expect(previewVatExclusive(500, 0).gross).toBe(500)
  })
})

describe('previewVatInclusive', () => {
  it('extracts 15% VAT from a gross amount', () => {
    expect(previewVatInclusive(11500, 1500)).toEqual({ net: 10000, vat: 1500, gross: 11500 })
  })
  it('always satisfies net + vat = gross', () => {
    for (const gross of [1, 99, 1234, 999_999]) {
      const p = previewVatInclusive(gross, 1500)
      expect(p.net + p.vat).toBe(gross)
    }
  })
  it('rejects invalid rates', () => {
    expect(() => previewVatInclusive(100, -1)).toThrow(RangeError)
  })
})
