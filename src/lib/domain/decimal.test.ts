import { describe, expect, it } from 'vitest'
import { formatEtb, formatQty, formatSignedQty, parseDecimal } from './decimal'

describe('parseDecimal', () => {
  it('accepts plain decimals up to the allowed fraction digits', () => {
    expect(parseDecimal('12', 2)).toBe(12)
    expect(parseDecimal(' 12.5 ', 2)).toBe(12.5)
    expect(parseDecimal('0.125', 3)).toBe(0.125)
    expect(parseDecimal('9999999999.99', 2)).toBe(9999999999.99)
  })

  it('refuses too many decimals, signs, exponents, grouping and non-Arabic digits', () => {
    expect(parseDecimal('1.234', 2)).toBeNull()
    expect(parseDecimal('-1', 2)).toBeNull()
    expect(parseDecimal('1e3', 2)).toBeNull()
    expect(parseDecimal('1,000', 2)).toBeNull()
    expect(parseDecimal('١٢', 2)).toBeNull()
    expect(parseDecimal('፲፪', 2)).toBeNull()
    expect(parseDecimal('', 2)).toBeNull()
    expect(parseDecimal('.5', 2)).toBeNull()
    expect(parseDecimal('5', 0)).toBe(5)
    expect(parseDecimal('5.1', 0)).toBeNull()
  })

  it('accepts a sign only when allowed', () => {
    expect(parseDecimal('-0.5', 3, true)).toBe(-0.5)
    expect(parseDecimal('+0.5', 3, true)).toBeNull()
  })

  it('sends exactly the typed decimal (JSON round trip)', () => {
    expect(JSON.stringify(parseDecimal('0.1', 2))).toBe('0.1')
    expect(JSON.stringify(parseDecimal('120.05', 2))).toBe('120.05')
  })
})

describe('formatEtb / formatQty', () => {
  it('formats ETB with Arabic numerals, grouping and 2 decimals', () => {
    expect(formatEtb(1250.5)).toBe('ETB 1,250.50')
    expect(formatEtb('85')).toBe('ETB 85.00')
    expect(formatEtb(0)).toBe('ETB 0.00')
    expect(formatEtb(1234567.891)).toBe('ETB 1,234,567.89')
    expect(formatEtb(null)).toBe('ETB —')
    expect(formatEtb(Number.NaN)).toBe('ETB —')
    expect(formatEtb(-5)).toBe('ETB -5.00')
  })

  it('formats quantities with up to 3 decimals, trimming zeros', () => {
    expect(formatQty(2.5)).toBe('2.5')
    expect(formatQty(1200)).toBe('1,200')
    expect(formatQty(0.125)).toBe('0.125')
    expect(formatQty(-0.25)).toBe('-0.25')
    expect(formatQty(0.1 + 0.2)).toBe('0.3')
    expect(formatQty(undefined)).toBe('—')
    expect(formatSignedQty(5)).toBe('+5')
    expect(formatSignedQty(-0.5)).toBe('-0.5')
  })
})
