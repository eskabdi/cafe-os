import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PinPad } from './PinPad'

function Harness({ onSubmit, disabled }: { onSubmit?: () => void; disabled?: boolean }) {
  const [v, setV] = useState('')
  return <PinPad value={v} onChange={setV} onSubmit={onSubmit} disabled={disabled} />
}

describe('PinPad', () => {
  it('has labelled buttons for every key and a named group', () => {
    render(<Harness />)
    expect(screen.getByRole('group', { name: 'PIN keypad' })).toBeInTheDocument()
    for (let d = 0; d <= 9; d++)
      expect(screen.getByRole('button', { name: `Digit ${d}` })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear PIN' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete last digit' })).toBeInTheDocument()
    // 44px+ touch targets (h-14 = 56px, min-w 44px)
    expect(screen.getByRole('button', { name: 'Digit 5' }).className).toMatch(/h-14/)
  })

  it('accepts clicks and physical keys, announces a count and never echoes digits', async () => {
    const user = userEvent.setup()
    const { container } = render(<Harness />)
    expect(container.querySelector('input')).toBeNull() // nothing to echo into
    await user.click(screen.getByRole('button', { name: 'Digit 1' }))
    await user.keyboard('23')
    expect(screen.getByRole('status')).toHaveTextContent('3 of 6 digits entered')
    expect(screen.getByRole('status').textContent).not.toMatch(/[123]{3}/)
    await user.keyboard('{Backspace}')
    expect(screen.getByRole('status')).toHaveTextContent('2 of 6 digits entered')
    await user.keyboard('{Escape}')
    expect(screen.getByRole('status')).toHaveTextContent('0 of 6 digits entered')
  })

  it('clears with the CLR button and caps at 6 digits', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.keyboard('123456789')
    expect(screen.getByRole('status')).toHaveTextContent('6 of 6')
    await user.click(screen.getByRole('button', { name: 'Clear PIN' }))
    expect(screen.getByRole('status')).toHaveTextContent('0 of 6')
  })

  it('allows submitting at 4 digits and keeps accepting up to 6 (Cashier PINs)', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.keyboard('48{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.keyboard('29{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await user.keyboard('16')
    expect(screen.getByRole('status')).toHaveTextContent('6 of 6')
  })

  it('ignores non-digits, submits on Enter only with 4 digits', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    await user.keyboard('ab12{Enter}')
    expect(onSubmit).not.toHaveBeenCalled()
    await user.keyboard('34{Enter}')
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does nothing while disabled', async () => {
    const user = userEvent.setup()
    render(<Harness disabled />)
    expect(screen.getByRole('button', { name: 'Digit 1' })).toBeDisabled()
    await user.keyboard('1234')
    expect(screen.getByRole('status')).toHaveTextContent('0 of 6')
  })
})
