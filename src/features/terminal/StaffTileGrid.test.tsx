import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { RosterTile } from '@/lib/supabase/staff-roster'
import { StaffTileGrid } from './StaffTileGrid'

const tile = (n: number, over: Partial<RosterTile> = {}): RosterTile => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  name: `Person ${n}`,
  role: `Role ${n}`,
  color: '#2563eb',
  icon: 'coffee',
  ...over,
})

function Harness({ tiles }: { tiles: RosterTile[] }) {
  const [sel, setSel] = useState<string | null>(null)
  return <StaffTileGrid tiles={tiles} selectedId={sel} onSelect={setSel} />
}

describe('StaffTileGrid', () => {
  it('is a labelled radio group with one radio per roster row', () => {
    render(<Harness tiles={[tile(1), tile(2), tile(3)]} />)
    expect(screen.getByRole('radiogroup', { name: 'Who is signing in' })).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
  })

  it('renders arbitrary roster rows incl. an unknown role with a custom colour and icon', () => {
    render(
      <Harness
        tiles={[
          tile(1, { name: 'Dawit Haile', role: 'Runner', color: '#fde047', icon: 'bike' }),
          tile(2, { name: 'Sara', role: 'Barista Lead', color: null, icon: 'not-in-allowlist' }),
        ]}
      />,
    )
    const runner = screen.getByRole('radio', { name: /Dawit Haile/ })
    expect(runner).toHaveTextContent('Runner')
    const swatch = runner.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(swatch.style.backgroundColor).toBe('rgb(253, 224, 71)')
    expect(swatch.querySelector('svg')).not.toBeNull()
    // unknown icon and null colour fall back to a generic icon and a neutral colour
    const other = screen.getByRole('radio', { name: /Sara/ })
    expect((other.querySelector('span[aria-hidden="true"]') as HTMLElement).style.backgroundColor).toBe(
      'rgb(71, 85, 105)',
    )
    expect(other.querySelector('svg')).not.toBeNull()
  })

  it('does not apply an invalid colour to the DOM', () => {
    render(<Harness tiles={[tile(1, { color: 'red; background:url(//evil)' })]} />)
    const swatch = screen.getByRole('radio').querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(swatch.getAttribute('style')).not.toMatch(/evil|url/)
  })

  it('renders no tiles for an empty roster and no admin or Cashier tile unless the roster has them', () => {
    const { rerender } = render(<Harness tiles={[]} />)
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    rerender(<Harness tiles={[tile(1, { role: 'Waiter' }), tile(2, { role: 'Kitchen' })]} />)
    expect(screen.queryByText(/admin|cashier/i)).toBeNull()
  })

  it('selects on click and exposes aria-checked', async () => {
    const user = userEvent.setup()
    render(<Harness tiles={[tile(1), tile(2)]} />)
    await user.click(screen.getByRole('radio', { name: /Person 2/ }))
    expect(screen.getByRole('radio', { name: /Person 2/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Person 1/ })).not.toBeChecked()
  })

  it('supports roving tabindex and arrow-key navigation with wrap-around', async () => {
    const user = userEvent.setup()
    render(<Harness tiles={[tile(1), tile(2), tile(3)]} />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])
    await user.tab()
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(radios[1]).toHaveFocus()
    await user.keyboard('{ArrowDown}{ArrowRight}')
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(radios[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(radios[0]).toHaveFocus()
    await user.keyboard('{End}')
    expect(radios[2]).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(radios[2]).toBeChecked()
  })

  it('has 44px+ targets and a visible focus style', () => {
    render(<Harness tiles={[tile(1)]} />)
    const r = screen.getByRole('radio')
    expect(r.className).toMatch(/min-h-\[7rem\]/)
    expect(r.className).toMatch(/focus-visible:ring-2/)
  })
})
