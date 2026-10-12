import { describe, expect, it } from 'vitest'
import {
  BRAND_VARS,
  DEFAULT_ACCENT,
  DEFAULT_PRIMARY,
  brandHex,
  brandThemeVars,
  hasLowWhiteTextContrast,
  hexToHslTriplet,
  whiteTextContrast,
} from './theme'

describe('brandHex (strict validation)', () => {
  it('accepts only #rrggbb', () => {
    expect(brandHex('#1D4ED8', DEFAULT_PRIMARY)).toBe('#1d4ed8')
    for (const bad of [
      '#fff',
      '1d4ed8',
      '#1d4ed8ff',
      ' #1d4ed8',
      'red',
      'url(x)',
      '#1d4ed8;color:red',
      null,
      12,
      {},
    ]) {
      expect(brandHex(bad, DEFAULT_PRIMARY)).toBe(DEFAULT_PRIMARY)
    }
  })
})

describe('hexToHslTriplet', () => {
  it('converts to the tailwind/shadcn triplet format', () => {
    expect(hexToHslTriplet('#dc2626')).toBe('0 72% 51%')
    expect(hexToHslTriplet('#ffffff')).toBe('0 0% 100%')
    expect(hexToHslTriplet('#000000')).toBe('0 0% 0%')
    expect(hexToHslTriplet('#1d4ed8')).toBe('224 76% 48%')
  })
})

describe('brandThemeVars', () => {
  it('applies tenant primary/accent', () => {
    const vars = brandThemeVars({ primary_color: '#1d4ed8', accent_color: '#16a34a' })
    expect(vars['--primary']).toBe('224 76% 48%')
    expect(vars['--ring']).toBe(vars['--primary'])
    expect(vars['--brand-accent']).toBe(hexToHslTriplet('#16a34a'))
    expect(vars['--primary-dark']).toBe(hexToHslTriplet('#16a34a'))
  })

  it('falls back to #dc2626 / #b91c1c for missing or invalid branding', () => {
    for (const branding of [undefined, null, 'x', {}, { primary_color: 'red', accent_color: '#12' }]) {
      const vars = brandThemeVars(branding)
      expect(vars['--primary']).toBe(hexToHslTriplet(DEFAULT_PRIMARY))
      expect(vars['--brand-accent']).toBe(hexToHslTriplet(DEFAULT_ACCENT))
    }
  })

  it('picks a readable foreground for a light primary', () => {
    expect(brandThemeVars({ primary_color: '#fde047' })['--primary-foreground']).toBe(
      hexToHslTriplet('#020617'),
    )
    expect(brandThemeVars({ primary_color: '#1e3a8a' })['--primary-foreground']).toBe('0 0% 100%')
  })

  it('never touches semantic status colours', () => {
    expect(BRAND_VARS.some((v) => v.startsWith('--status'))).toBe(false)
    expect(Object.keys(brandThemeVars({})).some((k) => k.includes('status'))).toBe(false)
  })
})

describe('white text contrast warning (branding editor)', () => {
  it('passes the CafeOS defaults and dark brand colours', () => {
    for (const ok of [DEFAULT_PRIMARY, DEFAULT_ACCENT, '#1d4ed8', '#000000', '#15803d']) {
      expect(hasLowWhiteTextContrast(ok)).toBe(false)
      expect(whiteTextContrast(ok)).toBeGreaterThanOrEqual(4.5)
    }
  })
  it('flags light colours under 4.5:1', () => {
    for (const low of ['#ffffff', '#facc15', '#22c55e', '#60a5fa', '#ef4444']) {
      expect(hasLowWhiteTextContrast(low)).toBe(true)
    }
  })
  it('computes the WCAG ratio (white on black = 21) and ignores invalid input', () => {
    expect(whiteTextContrast('#000000')).toBeCloseTo(21, 5)
    expect(whiteTextContrast('#FFFFFF')).toBeCloseTo(1, 5)
    for (const bad of ['#fff', 'red', '', null, undefined, 42]) {
      expect(whiteTextContrast(bad)).toBeNull()
      expect(hasLowWhiteTextContrast(bad)).toBe(false)
    }
  })
})
