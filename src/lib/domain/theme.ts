// Tenant branding -> CSS custom properties. Only the brand tokens (primary / accent) are ever overridden; the semantic status
// colours (--status-*) are platform-wide and deliberately absent here.

import { contrastRatio, readableForeground } from './tile-style'

export const DEFAULT_PRIMARY = '#dc2626'
export const DEFAULT_ACCENT = '#b91c1c'

const STRICT_HEX = /^#[0-9a-fA-F]{6}$/

/** Strict #rrggbb (no shorthand, no alpha, no names, no whitespace) lower-cased, or the fallback. */
export function brandHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && STRICT_HEX.test(value) ? value.toLowerCase() : fallback
}

/** `#rrggbb` -> Tailwind/shadcn HSL triplet "h s% l%" (integers). Input must already be a strict hex. */
export function hexToHslTriplet(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`
}

export const BRAND_VARS = [
  '--primary',
  '--primary-dark',
  '--primary-foreground',
  '--ring',
  '--brand-accent',
  '--brand-accent-foreground',
] as const
export type BrandVar = (typeof BRAND_VARS)[number]

/** CSS variables for a restaurant's `branding` jsonb. Anything invalid falls back to the CafeOS defaults. */
export function brandThemeVars(branding: unknown): Record<BrandVar, string> {
  const b = branding && typeof branding === 'object' ? (branding as Record<string, unknown>) : {}
  const primary = brandHex(b.primary_color, DEFAULT_PRIMARY)
  const accent = brandHex(b.accent_color, DEFAULT_ACCENT)
  return {
    '--primary': hexToHslTriplet(primary),
    '--primary-dark': hexToHslTriplet(accent),
    '--primary-foreground': hexToHslTriplet(readableForeground(primary)),
    '--ring': hexToHslTriplet(primary),
    '--brand-accent': hexToHslTriplet(accent),
    '--brand-accent-foreground': hexToHslTriplet(readableForeground(accent)),
  }
}

/** WCAG AA minimum for normal text. Branded buttons render white text on the brand colour. */
export const MIN_TEXT_CONTRAST = 4.5

/**
 * Contrast of white button text on a brand colour, or null when the value is not a strict #rrggbb.
 * Used by the branding editor to WARN (not block) when the ratio is under MIN_TEXT_CONTRAST.
 */
export function whiteTextContrast(value: unknown): number | null {
  if (typeof value !== 'string' || !STRICT_HEX.test(value)) return null
  return contrastRatio(value.toLowerCase(), '#ffffff')
}

/** True when white text on this brand colour falls below WCAG AA (4.5:1). Invalid input is not flagged (the hex check reports it). */
export function hasLowWhiteTextContrast(value: unknown): boolean {
  const ratio = whiteTextContrast(value)
  return ratio !== null && ratio < MIN_TEXT_CONTRAST
}
