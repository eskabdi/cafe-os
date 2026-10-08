import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { hexToHslTriplet } from '@/lib/domain/theme'
import { TenantThemeProvider } from './TenantThemeProvider'

const root = () => document.documentElement.style

describe('TenantThemeProvider', () => {
  it('applies primary/accent from the branding row as CSS variables and removes them on unmount', () => {
    const view = render(
      <TenantThemeProvider branding={{ primary_color: '#1d4ed8', accent_color: '#16a34a' }}>
        <p>child</p>
      </TenantThemeProvider>,
    )
    expect(root().getPropertyValue('--primary')).toBe('224 76% 48%')
    expect(root().getPropertyValue('--brand-accent')).toBe(hexToHslTriplet('#16a34a'))
    expect(root().getPropertyValue('--status-error')).toBe('')
    view.unmount()
    expect(root().getPropertyValue('--primary')).toBe('')
  })

  it('falls back to #dc2626 for an invalid colour (nothing unvalidated reaches the style)', () => {
    render(
      <TenantThemeProvider branding={{ primary_color: 'red; background: url(x)' }}>
        <p>child</p>
      </TenantThemeProvider>,
    )
    expect(root().getPropertyValue('--primary')).toBe(hexToHslTriplet('#dc2626'))
  })

  it('updates when the branding changes', () => {
    const view = render(
      <TenantThemeProvider branding={{ primary_color: '#1d4ed8' }}>
        <p>child</p>
      </TenantThemeProvider>,
    )
    view.rerender(
      <TenantThemeProvider branding={{ primary_color: '#000000' }}>
        <p>child</p>
      </TenantThemeProvider>,
    )
    expect(root().getPropertyValue('--primary')).toBe('0 0% 0%')
  })
})
