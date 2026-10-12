import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginNoticeFromState } from '@/features/auth/login-notice'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { ResetPasswordPage, updatePasswordOutcome } from './ResetPasswordPage'

const auth = vi.hoisted(() => ({ setSession: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth } }))
const rpc = vi.hoisted(() => ({ getSessionContext: vi.fn() }))
vi.mock('@/lib/supabase/rpc', () => rpc)

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1LTEifQ.c2ln'
const LINK = `/reset-password#access_token=${JWT}&expires_in=3600&refresh_token=r-1&token_type=bearer&type=recovery`
const GOOD = 'New-password-2026'

function authValue(over: Partial<AuthValue> = {}): AuthValue {
  return {
    status: 'authenticated',
    session: null,
    context: {
      restaurant: { id: 'r', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    } as AuthValue['context'],
    contextStatus: 'ready',
    can: () => false,
    signOut: vi.fn(),
    refreshContext: vi.fn(),
    ...over,
  }
}

function LoginProbe() {
  const notice = loginNoticeFromState(useLocation().state)
  return <p>admin login {notice}</p>
}

function renderPage(url: string, value: AuthValue = authValue()) {
  window.history.replaceState(null, '', url)
  return render(
    <AuthContext.Provider value={value}>
      <MemoryRouter initialEntries={['/reset-password']}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/r/:slug/admin-login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

async function fill(user: ReturnType<typeof userEvent.setup>, pw: string, again = pw) {
  await user.type(await screen.findByLabelText('New password'), pw)
  await user.type(screen.getByLabelText('Repeat the new password'), again)
  await user.click(screen.getByRole('button', { name: 'Save new password' }))
}

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    auth.setSession.mockResolvedValue({ data: {}, error: null })
    auth.updateUser.mockResolvedValue({ data: {}, error: null })
    auth.signOut.mockResolvedValue({ error: null })
  })
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('takes the recovery session, removes it from the URL and explains the authenticator reset', async () => {
    renderPage(LINK)
    expect(await screen.findByLabelText('New password')).toBeInTheDocument()
    expect(auth.setSession).toHaveBeenCalledWith({ access_token: JWT, refresh_token: 'r-1' })
    expect(auth.setSession).toHaveBeenCalledTimes(1)
    expect(window.location.hash).toBe('')
    expect(screen.getByText(/platform administrator reset your authenticator/)).toBeInTheDocument()
  })

  it('changes the password, signs out everywhere and sends the person to admin sign-in with the notice', async () => {
    const user = userEvent.setup()
    renderPage(LINK)
    await fill(user, GOOD)
    expect(await screen.findByText(/admin login/)).toHaveTextContent(
      'Password changed. Sign in, then set up your authenticator again.',
    )
    expect(auth.updateUser).toHaveBeenCalledWith({ password: GOOD })
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' })
    expect(auth.signOut).toHaveBeenCalledTimes(1)
  })

  it('falls back to a local sign-out when the global sign-out fails, and warns (without blocking) on the sign-in page', async () => {
    const user = userEvent.setup()
    auth.signOut.mockResolvedValueOnce({ error: { status: 500 } }).mockResolvedValueOnce({ error: null })
    renderPage(LINK)
    await fill(user, GOOD)
    expect(await screen.findByText(/admin login/)).toHaveTextContent(
      /Password changed\. Signing out your other devices could not be confirmed; their old sessions are blocked from every authenticator-protected action/,
    )
    expect(auth.signOut).toHaveBeenNthCalledWith(2, { scope: 'local' })
  })

  it('reads the restaurant from the server when the context is not loaded; without one it stays on the page with a way on', async () => {
    const user = userEvent.setup()
    rpc.getSessionContext.mockResolvedValue(null)
    renderPage(LINK, authValue({ context: null, contextStatus: 'loading' }))
    await fill(user, GOOD)
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Password changed\. Sign in, then set up your authenticator again/,
    )
    expect(screen.getByText(/\/r\/<your restaurant>\/admin-login/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the start page' })).toHaveAttribute('href', '/')
    expect(auth.signOut).toHaveBeenCalledWith({ scope: 'global' })
  })

  it('without a restaurant and with a failed global sign-out, the done state carries the warning', async () => {
    const user = userEvent.setup()
    rpc.getSessionContext.mockResolvedValue(null)
    auth.signOut.mockResolvedValueOnce({ error: { status: 500 } }).mockResolvedValueOnce({ error: null })
    renderPage(LINK, authValue({ context: null, contextStatus: 'loading' }))
    await fill(user, GOOD)
    expect(await screen.findByRole('status')).toHaveTextContent(/could not be confirmed/)
  })

  it('applies the password policy before calling the server', async () => {
    const user = userEvent.setup()
    renderPage(LINK)
    await fill(user, 'short1')
    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 12/)
    await user.clear(screen.getByLabelText('New password'))
    await user.clear(screen.getByLabelText('Repeat the new password'))
    await fill(user, 'new password 2026')
    expect(await screen.findByRole('alert')).toHaveTextContent(/uppercase/)
    await user.clear(screen.getByLabelText('New password'))
    await user.clear(screen.getByLabelText('Repeat the new password'))
    await fill(user, GOOD, `${GOOD}x`)
    expect(await screen.findByRole('alert')).toHaveTextContent(/differ/)
    expect(auth.updateUser).not.toHaveBeenCalled()
  })

  it('shows a fixed message when the server refuses the password', async () => {
    const user = userEvent.setup()
    auth.updateUser.mockResolvedValue({
      data: {},
      error: { status: 422, code: 'weak_password', message: 'raw server text' },
    })
    renderPage(LINK)
    await fill(user, GOOD)
    expect(await screen.findByRole('alert')).toHaveTextContent(/too weak/)
    expect(screen.queryByText(/raw server text/)).toBeNull()
    expect(auth.signOut).not.toHaveBeenCalled()
  })

  it('treats a recovery session that ended as an expired link', async () => {
    const user = userEvent.setup()
    auth.updateUser.mockResolvedValue({ data: {}, error: { status: 403, code: 'session_not_found' } })
    renderPage(LINK)
    await fill(user, GOOD)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /expired or has already been used\. Ask the platform administrator to resend the recovery email/,
    )
  })

  it('expired / used link (GoTrue error in the fragment): asks for a new reset, no session call', async () => {
    renderPage(
      '/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid',
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Ask the platform administrator to resend the recovery email/,
    )
    expect(auth.setSession).not.toHaveBeenCalled()
    expect(window.location.hash).toBe('')
  })

  it('a recovery token GoTrue rejects is shown as expired', async () => {
    auth.setSession.mockResolvedValue({ data: {}, error: { status: 403, code: 'bad_jwt' } })
    renderPage(LINK)
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or has already been used/)
  })

  it('refuses any link type other than recovery', async () => {
    renderPage(LINK.replace('type=recovery', 'type=signup'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a valid password-reset link/)
    expect(auth.setSession).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('New password')).toBeNull()
  })

  it('without a link it shows no form', () => {
    renderPage('/reset-password')
    expect(screen.getByText(/Open the link in the password-reset e-mail/)).toBeInTheDocument()
    expect(screen.queryByLabelText('New password')).toBeNull()
  })
})

describe('updatePasswordOutcome', () => {
  it('maps server errors to fixed copy', () => {
    expect(updatePasswordOutcome({ status: 401 })).toBe('expired')
    expect(updatePasswordOutcome({ status: 400, code: 'session_expired' })).toBe('expired')
    expect(updatePasswordOutcome({ status: 429 })).toMatch(/Too many attempts/)
    expect(updatePasswordOutcome({ status: 422, code: 'same_password' })).toMatch(/not used/)
    expect(updatePasswordOutcome({ status: 500 })).toMatch(/could not be saved/)
  })
})
