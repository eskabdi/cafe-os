// Pure presentation helpers for kiosk staff tiles. Colour and icon come from the role ROW; nothing here knows a role name.

const HEX = /^#[0-9a-fA-F]{6}$/

/** Neutral fallback when the row has no (valid) colour: slate-600. Not a semantic status colour and not the brand red. */
export const FALLBACK_TILE_COLOR = '#475569'

/** Returns the colour only when it is a strict #rrggbb hex (it is applied through inline style, so nothing else may pass). */
export function safeHexColor(value: string | null | undefined): string | null {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null
}

function channel(v: number): number {
  const c = v / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const LIGHT = '#ffffff'
const DARK = '#020617'

/** White or near-black, whichever reads better on `background` (always >= 4.5:1 for one of them). */
export function readableForeground(background: string): string {
  return contrastRatio(background, LIGHT) >= contrastRatio(background, DARK) ? LIGHT : DARK
}

export interface TileStyle {
  background: string
  foreground: string
}

export function tileStyle(color: string | null | undefined): TileStyle {
  const background = safeHexColor(color) ?? FALLBACK_TILE_COLOR
  return { background, foreground: readableForeground(background) }
}
