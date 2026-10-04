import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PIN_LOGIN_MESSAGES } from '@/lib/supabase/pin-login-errors'
import type { RosterTile } from '@/lib/supabase/staff-roster'
import { TerminalPinEntry } from './TerminalPinEntry'

const pinLoginTile = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/pin-login', () => ({ pinLoginTile }))

const TOKEN = 'cd'.repeat(32)
const tile: RosterTile = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Abebe Kebede',
  role: 'Runner',
  color: null,
  icon: null,
}

function setup(props: Partial<React.ComponentProps<typeof TerminalPinEntry>> = {}) {
  const onCancel = vi.fn()
  const onSignedIn = vi.fn()
  render(
    <TerminalPinEntry
      slug="demo-cafe"
      kioskToken={TOKEN}
      tile={tile}
      onCancel={onCancel}
      onSignedIn={onSignedIn}
      {...props}
    />,
  )
  return { onCancel, onSignedIn }
}

beforeEach(() => {
  pinLoginTile.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('TerminalPinEntry', () => {
  it('shows neutral copy only', () => {
    setup()
    expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/lock|attempt|wrong|incorrect|invalid|token|kiosk/i)
  })

  it('signs in through the tile path with exactly the tile request', async () => {
    const user = userEvent.setup()
    pinLoginTile.mockResolvedValue({ ok: true })
    const { onSignedIn } = setup()
    await user.keyboard('4829')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(pinLoginTile).toHaveBeenCalledWith({
      restaurant_slug: 'demo-cafe',
      kiosk_token: TOKEN,
      profile_id: tile.id,
      pin: '4829',
    })
  })

  it.each(['invalid_credentials', 'rate_limited', 'network', 'server_error'] as const)(
    'shows the generic %s message, clears the PIN and does not sign in',
    async (reason) => {
      const user = userEvent.setup()
      pinLoginTile.mockResolvedValue({ ok: false, reason })
      const { onSignedIn } = setup()
      await user.keyboard('4829{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent(PIN_LOGIN_MESSAGES[reason])
      expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument()
      expect(onSignedIn).not.toHaveBeenCalled()
    },
  )

  it('maps a thrown error to the generic server message without leaking detail', async () => {
    const user = userEvent.setup()
    pinLoginTile.mockImplementation(() => {
      throw new Error('boom secret')
    })
    setup()
    await user.keyboard('4829{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(PIN_LOGIN_MESSAGES.server_error)
    expect(alert.textContent).not.toContain('secret')
  })

  it('clears the error as soon as the user types again', async () => {
    const user = userEvent.setup()
    pinLoginTile.mockResolvedValue({ ok: false, reason: 'invalid_credentials' })
    setup()
    await user.keyboard('4829{Enter}')
    await screen.findByRole('alert')
    await user.keyboard('1')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('"Not you?" cancels and never calls the server', async () => {
    const user = userEvent.setup()
    const { onCancel } = setup()
    await user.keyboard('12')
    await user.click(screen.getByRole('button', { name: 'Not you?' }))
    expect(onCancel).toHaveBeenCalled()
    expect(pinLoginTile).not.toHaveBeenCalled()
  })

  it('returns to the tiles after 60s idle, and activity restarts the countdown', () => {
    vi.useFakeTimers()
    const { onCancel } = setup()
    act(() => {
      vi.advanceTimersByTime(59_000)
    })
    expect(onCancel).not.toHaveBeenCalled()
    act(() => {
      document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(59_000)
    })
    expect(onCancel).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(1_500)
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('does not time out while a sign-in is in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let resolve!: (v: { ok: true }) => void
    pinLoginTile.mockReturnValue(new Promise((r) => (resolve = r)))
    const { onCancel, onSignedIn } = setup()
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    await user.keyboard('4829{Enter}')
    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => resolve({ ok: true }))
    expect(onSignedIn).toHaveBeenCalled()
  })
})
