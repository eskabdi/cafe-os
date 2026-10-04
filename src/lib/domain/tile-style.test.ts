import { describe, expect, it } from 'vitest'
import { FALLBACK_TILE_COLOR, contrastRatio, readableForeground, safeHexColor, tileStyle } from './tile-style'

describe('safeHexColor', () => {
  it('accepts only strict #rrggbb', () => {
    expect(safeHexColor('#DC2626')).toBe('#dc2626')
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '#123456; x', null, undefined, ''])
      expect(safeHexColor(bad)).toBeNull()
  })
})

describe('tileStyle', () => {
  it('falls back to a neutral colour for invalid input', () => {
    expect(tileStyle('javascript:1').background).toBe(FALLBACK_TILE_COLOR)
  })

  it('always yields a foreground with >= 4.5:1 contrast across a colour sweep', () => {
    for (let r = 0; r < 256; r += 51)
      for (let g = 0; g < 256; g += 51)
        for (let b = 0; b < 256; b += 51) {
          const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
          expect(contrastRatio(hex, readableForeground(hex))).toBeGreaterThanOrEqual(4.5)
        }
  })

  it('picks dark text on light colours and light text on dark ones', () => {
    expect(readableForeground('#fde047')).toBe('#020617')
    expect(readableForeground('#1e3a8a')).toBe('#ffffff')
  })
})
