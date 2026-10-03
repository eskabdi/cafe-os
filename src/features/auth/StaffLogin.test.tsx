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
  beforeEach(() => pinLogin.mockReset())

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
    await user.keyboard('1234')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(pinLogin).toHaveBeenCalledWith({ restaurant_slug: 'demo-cafe', username: 'abebe', pin: '1234' })
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
    await user.keyboard('1234{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent(PIN_LOGIN_MESSAGES[reason])
    expect(screen.getByRole('status')).toHaveTextContent('0 of 6')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('shows one generic message for lockout, unknown user, admin and wrong PIN', () => {
    // all four are the same server response (401 invalid_credentials) and cannot be told apart in the UI
    expect(PIN_LOGIN_MESSAGES.invalid_credentials).toMatch(
      /Incorrect username or PIN, or the account is temporarily locked/,
    )
  })

  it('maps a thrown error to the generic server message', async () => {
    const user = userEvent.setup()
    pinLogin.mockImplementation(() => {
      throw new Error('boom: secret detail')
    })
    render(<StaffLogin slug="demo-cafe" />)
    await toPinStep(user)
    await user.keyboard('1234{Enter}')
    await new Promise((r) => setTimeout(r, 50))
    screen.debug(undefined, 4000)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(PIN_LOGIN_MESSAGES.server_error)
    expect(alert.textContent).not.toContain('secret')
  })

  it('keeps the Sign in button disabled until 4 digits are entered', async () => {
    const user = userEvent.setup()
    render(<StaffLogin slug="demo-cafe" />)
    await toPinStep(user)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled()
    await user.keyboard('1234')
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })
})
