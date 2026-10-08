import { describe, expect, it } from 'vitest'
import {
  BRAND_VARS,
  DEFAULT_ACCENT,
  DEFAULT_PRIMARY,
  brandHex,
  brandThemeVars,
  hexToHslTriplet,
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
