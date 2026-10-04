import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import type { PinChangeFailure, PinChangeResult } from '@/lib/supabase/pin-change'
import { pinChangeMessage } from '@/lib/supabase/pin-change-errors'
import { ChangePinPage } from './ChangePinPage'

const h = vi.hoisted(() => ({ changePin: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/pin-change', () => ({ changePin: h.changePin }))

const signOut = vi.fn().mockResolvedValue(undefined)
const refreshContext = vi.fn()
let client: QueryClient

function renderPage(pinLength: 4 | 6 | null = 4) {
  client = new QueryClient()
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: {
      user: { id: 'u-1', first_name: 'Abebe', username: 'abebe' },
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      role: { id: 'role', name: 'Some Role', system_key: null, is_active: true },
      permissions: [],
      station_ids: [],
      pin_change_status: 'required',
      must_change_pin: true,
      pin_length: pinLength,
    },
    contextStatus: 'ready',
    can: () => false,
    signOut,
    refreshContext,
  }
  render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ChangePinPage />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

type User = ReturnType<typeof userEvent.setup>
async function enter(user: User, pin: string, submit: string) {
  for (const d of pin) await user.click(screen.getByRole('button', { name: `Digit ${d}` }))
  await user.click(screen.getByRole('button', { name: submit }))
}
async function fullChange(user: User, current = '4829', next = '7391', confirm = next) {
  await enter(user, current, 'Next')
  await enter(user, next, 'Next')
  await enter(user, confirm, 'Change PIN')
}
const stepHeading = () => screen.getByRole('heading', { level: 2 }).textContent

beforeEach(() => {
  h.changePin.mockReset()
  signOut.mockClear()
  refreshContext.mockClear()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('ChangePinPage', () => {
  it('walks current -> new -> confirm with a fixed-length pad and never echoes digits', async () => {
    const user = userEvent.setup()
    let resolve!: (r: PinChangeResult) => void
    h.changePin.mockImplementation(() => new Promise<PinChangeResult>((r) => (resolve = r)))
    renderPage()
    expect(stepHeading()).toBe('Enter your current PIN')
    expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument()
    await enter(user, '4829', 'Next')
    expect(stepHeading()).toBe('Choose a new PIN')
    await enter(user, '7391', 'Next')
    expect(stepHeading()).toBe('Enter the new PIN again')
    await enter(user, '7391', 'Change PIN')

    expect(h.changePin).toHaveBeenCalledWith({ current_pin: '4829', new_pin: '7391' })
    // in flight: the pad is locked and cleared, and no PIN sits in the DOM or in the mutation cache
    expect(screen.getByRole('button', { name: 'Digit 1' })).toBeDisabled()
    expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/4829|7391/)
    for (const m of client.getMutationCache().getAll()) expect(m.state.variables).toBeUndefined()

    await act(async () => resolve({ ok: true, pendingApproval: true, otherSessionsRevoked: true }))
    expect(await screen.findByRole('heading', { name: 'Your PIN has been changed' })).toHaveFocus()
    expect(
      screen.getByText('A manager needs to approve the change before you can continue.'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/other device/)).toBeNull()
    expect(refreshContext).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    expect(refreshContext).toHaveBeenCalledTimes(1)
  })

  it('tells the user to sign out elsewhere when other sessions were not revoked', async () => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: true, pendingApproval: false, otherSessionsRevoked: false })
    renderPage()
    await fullChange(user)
    expect(await screen.findByText('You can continue working.')).toBeInTheDocument()
    expect(
      screen.getByText('Sign out on any other device where you may still be signed in.'),
    ).toBeInTheDocument()
  })

  it('uses 6 digits when the server says so (Cashier exception decided server-side)', async () => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: true, pendingApproval: true, otherSessionsRevoked: true })
    renderPage(6)
    expect(screen.getByText('0 of 6 digits entered')).toBeInTheDocument()
    await enter(user, '4829', 'Next') // 4 digits are not enough: the submit key stays disabled
    expect(stepHeading()).toBe('Enter your current PIN')
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
    await enter(user, '10', 'Next')
    await enter(user, '739154', 'Next')
    await enter(user, '739154', 'Change PIN')
    expect(h.changePin).toHaveBeenCalledWith({ current_pin: '482910', new_pin: '739154' })
  })

  it('supports the physical keyboard', async () => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: true, pendingApproval: true, otherSessionsRevoked: true })
    renderPage()
    await user.keyboard('4829{Enter}')
    await user.keyboard('7391{Enter}')
    await user.keyboard('7391{Enter}')
    expect(h.changePin).toHaveBeenCalledWith({ current_pin: '4829', new_pin: '7391' })
  })

  it('catches a mismatched confirmation locally and returns to the new-PIN step', async () => {
    const user = userEvent.setup()
    renderPage()
    await fullChange(user, '4829', '7391', '7392')
    expect(h.changePin).not.toHaveBeenCalled()
    expect(stepHeading()).toBe('Choose a new PIN')
    expect(screen.getByRole('alert')).toHaveTextContent('The two new PINs did not match.')
  })

  it('refuses a new PIN equal to the current one before sending', async () => {
    const user = userEvent.setup()
    renderPage()
    await enter(user, '4829', 'Next')
    await enter(user, '4829', 'Next')
    expect(stepHeading()).toBe('Choose a new PIN')
    expect(screen.getByRole('alert')).toHaveTextContent(pinChangeMessage('same_pin', 4))
    expect(h.changePin).not.toHaveBeenCalled()
  })

  it('Back from confirm keeps the current PIN; Back from new starts over', async () => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: true, pendingApproval: true, otherSessionsRevoked: true })
    renderPage()
    await enter(user, '4829', 'Next')
    await enter(user, '7391', 'Next')
    await user.click(screen.getByRole('button', { name: 'Back' }))
    expect(stepHeading()).toBe('Choose a new PIN')
    await enter(user, '6150', 'Next')
    await enter(user, '6150', 'Change PIN')
    expect(h.changePin).toHaveBeenCalledWith({ current_pin: '4829', new_pin: '6150' })
  })

  it.each<PinChangeFailure>([
    'invalid_credentials',
    'weak_pin',
    'same_pin',
    'invalid_pin_length',
    'invalid_request',
    'network',
    'server_error',
  ])('shows neutral copy for %s and starts over with nothing kept', async (reason) => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: false, reason })
    renderPage()
    await fullChange(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(pinChangeMessage(reason, 4))
    expect(stepHeading()).toBe('Enter your current PIN')
    expect(screen.getByText('0 of 4 digits entered')).toBeInTheDocument()
    expect(screen.getByRole('alert').textContent).not.toMatch(/lock|attempt/i)
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
  })

  it('unauthorized: offers to sign in again', async () => {
    const user = userEvent.setup()
    h.changePin.mockResolvedValue({ ok: false, reason: 'unauthorized' })
    renderPage()
    await fullChange(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session has ended.')
    await user.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(signOut).toHaveBeenCalledTimes(1)
  })

  it('429: locks the pad for Retry-After seconds, then lets the user try again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    h.changePin.mockResolvedValue({ ok: false, reason: 'rate_limited', retryAfterSec: 3 })
    renderPage()
    await fullChange(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts. Try again in 3 seconds.')
    expect(screen.getByTestId('retry-countdown')).toHaveTextContent('You can try again in 3 seconds.')
    expect(screen.getByRole('button', { name: 'Digit 1' })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500)
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Digit 1' })).toBeEnabled())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByTestId('retry-countdown')).toBeNull()
  })

  it('without a server pin_length it does not guess a length', () => {
    renderPage(null)
    expect(screen.getByRole('alert')).toHaveTextContent('Your PIN settings could not be loaded.')
    expect(screen.queryByRole('group')).toBeNull()
    screen.getByRole('button', { name: 'Retry' }).click()
    expect(refreshContext).toHaveBeenCalled()
  })
})
