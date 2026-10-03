import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PIN_LOGIN_MESSAGES } from '@/lib/supabase/pin-login-errors'
import { StaffLogin } from './StaffLogin'

const pinLogin = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/pin-login', () => ({ pinLogin }))

async function toPinStep(user: ReturnType<typeof userEvent.setup>, username = 'Abebe') {
  await user.type(screen.getByLabelText('Username'), username)
  await user.click(screen.getByRole('button', { name: 'Continue' }))
}

describe('StaffLogin', () => {
  beforeEach(() => {
    pinLogin.mockReset()
  })

  it('rejects an invalid username locally without calling the server', async () => {
    const user = userEvent.setup()
    render(<StaffLogin slug="demo-cafe" />)
    await toPinStep(user, 'a b')
    expect(screen.getByRole('alert')).toHaveTextContent(PIN_LOGIN_MESSAGES.invalid_request)
    expect(pinLogin).not.toHaveBeenCalled()
  })

  it('submits a normalized request and reports success', async () => {
    const user = userEvent.setup()
    pinLogin.mockResolvedValue({ ok: true })
    const onSignedIn = vi.fn()
    render(<StaffLogin slug="demo-cafe" onSignedIn={onSignedIn} />)
    await toPinStep(user)
    await user.keyboard('4829')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(pinLogin).toHaveBeenCalledWith({ restaurant_slug: 'demo-cafe', username: 'abebe', pin: '4829' })
  })

  it.each([
    ['invalid_credentials'],
    ['rate_limited'],
    ['invalid_request'],
    ['network'],
    ['server_error'],
  ] as const)('maps %s to a safe message and clears the PIN', async (reason) => {
    const user = userEvent.setup()
    pinLogin.mockResolvedValue({ ok: false, reason })
    const onSignedIn = vi.fn()
    render(<StaffLogin slug="demo-cafe" onSignedIn={onSignedIn} />)
    await toPinStep(user)
    await user.keyboard('4829{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(PIN_LOGIN_MESSAGES[reason])
    expect(screen.getByRole('status')).toHaveTextContent('0 of 6')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('shows one generic message for lockout, unknown user, admin, wrong PIN and an already-active session', () => {
    // all five are the same server response (401 invalid_credentials) and cannot be told apart in the UI
    expect(PIN_LOGIN_MESSAGES.invalid_credentials).toBe(
      'Could not sign in. Check your username and PIN, or sign out of any other device first. If it keeps happening, ask your manager.',
    )
  })

  it('maps a thrown error to the generic server message', async () => {
    const user = userEvent.setup()
    pinLogin.mockImplementation(async () => {
      throw new Error('boom: secret detail')
    })
    render(<StaffLogin slug="demo-cafe" />)
    await toPinStep(user)
    await user.keyboard('4829{Enter}')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(PIN_LOGIN_MESSAGES.server_error)
    expect(alert.textContent).not.toContain('secret')
  })

  it('lets a Cashier sign in with a 6-digit PIN', async () => {
    const user = userEvent.setup()
    pinLogin.mockResolvedValue({ ok: true })
    render(<StaffLogin slug="demo-cafe" onSignedIn={vi.fn()} />)
    await toPinStep(user)
    await user.keyboard('480516')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(pinLogin).toHaveBeenCalled())
    expect(pinLogin).toHaveBeenCalledWith({ restaurant_slug: 'demo-cafe', username: 'abebe', pin: '480516' })
  })

  it('keeps the Sign in button disabled until 4 digits are entered', async () => {
    const user = userEvent.setup()
    render(<StaffLogin slug="demo-cafe" />)
    await toPinStep(user)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    await user.keyboard('4829')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})
