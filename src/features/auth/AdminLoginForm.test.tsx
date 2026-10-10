import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminLoginForm } from './AdminLoginForm'

const auth = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signOut: vi.fn(),
  mfa: { getAuthenticatorAssuranceLevel: vi.fn(), listFactors: vi.fn(), challengeAndVerify: vi.fn() },
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: { auth } }))
const devices = vi.hoisted(() => ({ checkThisDevice: vi.fn(), trustThisDevice: vi.fn() }))
vi.mock('@/lib/supabase/trusted-devices', () => devices)

async function fillAndSubmit(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'owner@example.com')
  await user.type(screen.getByLabelText('Password'), 'correct horse')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('AdminLoginForm', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    auth.signOut.mockResolvedValue({ error: null })
    devices.checkThisDevice.mockResolvedValue(false)
    devices.trustThisDevice.mockResolvedValue(undefined)
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal1' },
      error: null,
    })
  })

  it('happy path: signs in with email + password and reports success', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    const onSignedIn = vi.fn()
    render(<AdminLoginForm onSignedIn={onSignedIn} />)
    await fillAndSubmit(user)
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'owner@example.com',
      password: 'correct horse',
    })
  })

  it('failure: shows a generic message and clears the password', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 400, code: 'invalid_credentials' },
    })
    const onSignedIn = vi.fn()
    render(<AdminLoginForm onSignedIn={onSignedIn} />)
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.')
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('maps rate limiting to a wait message', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({
      data: {},
      error: { status: 429, code: 'over_request_rate_limit' },
    })
    render(<AdminLoginForm />)
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/)
  })

  it('MFA path: asks for a TOTP code when the user has an enrolled factor, then completes', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
    auth.mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    const onSignedIn = vi.fn()
    render(<AdminLoginForm onSignedIn={onSignedIn} />)
    await fillAndSubmit(user)
    expect(onSignedIn).not.toHaveBeenCalled()
    await user.type(await screen.findByLabelText('Authentication code'), '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(auth.mfa.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' })
  })

  it('MFA path: a wrong code shows an error and does not sign in', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
    auth.mfa.challengeAndVerify.mockResolvedValue({ data: null, error: { message: 'Invalid TOTP code' } })
    const onSignedIn = vi.fn()
    render(<AdminLoginForm onSignedIn={onSignedIn} />)
    await fillAndSubmit(user)
    await user.type(await screen.findByLabelText('Authentication code'), '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect or has expired/)
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('MFA required but no factor listed: signs out instead of continuing', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({
      data: { currentLevel: 'aal1', nextLevel: 'aal2' },
      error: null,
    })
    auth.mfa.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    const onSignedIn = vi.fn()
    render(<AdminLoginForm onSignedIn={onSignedIn} />)
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent(/Two-step verification/)
    expect(auth.signOut).toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('verify() returning false signs out and shows the denied message (platform admin check)', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    const onSignedIn = vi.fn()
    render(
      <AdminLoginForm
        verify={async () => false}
        deniedMessage="Not a platform admin."
        onSignedIn={onSignedIn}
      />,
    )
    await fillAndSubmit(user)
    expect(await screen.findByRole('alert')).toHaveTextContent('Not a platform admin.')
    expect(auth.signOut).toHaveBeenCalled()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('verify() throwing is treated as denied', async () => {
    const user = userEvent.setup()
    auth.signInWithPassword.mockResolvedValue({ data: {}, error: null })
    const onSignedIn = vi.fn()
    render(
      <AdminLoginForm
        verify={async () => {
          throw new Error('rpc down')
        }}
        onSignedIn={onSignedIn}
      />,
    )
    await fillAndSubmit(user)
    await waitFor(() => expect(auth.signOut).toHaveBeenCalled())
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  describe('trusted device (30 days)', () => {
    const mfaUser = () => {
      auth.signInWithPassword.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
      auth.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
      auth.mfa.listFactors.mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
      auth.mfa.challengeAndVerify.mockResolvedValue({ data: {}, error: null })
    }

    it('a trusted browser skips the code', async () => {
      const user = userEvent.setup()
      mfaUser()
      devices.checkThisDevice.mockResolvedValue(true)
      const onSignedIn = vi.fn()
      render(<AdminLoginForm onSignedIn={onSignedIn} />)
      await fillAndSubmit(user)
      await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
      expect(devices.checkThisDevice).toHaveBeenCalledWith('user-1')
      expect(auth.mfa.challengeAndVerify).not.toHaveBeenCalled()
      expect(screen.queryByLabelText('Authentication code')).not.toBeInTheDocument()
    })

    it('a new browser asks the code, then trusts the device by default', async () => {
      const user = userEvent.setup()
      mfaUser()
      const onSignedIn = vi.fn()
      render(<AdminLoginForm onSignedIn={onSignedIn} />)
      await fillAndSubmit(user)
      expect(screen.getByRole('checkbox', { name: 'Trust this device for 30 days' })).toBeChecked()
      await user.type(await screen.findByLabelText('Authentication code'), '123456')
      await user.click(screen.getByRole('button', { name: 'Verify' }))
      await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
      expect(devices.trustThisDevice).toHaveBeenCalledWith('user-1')
    })

    it('unticked: the device is not remembered', async () => {
      const user = userEvent.setup()
      mfaUser()
      const onSignedIn = vi.fn()
      render(<AdminLoginForm onSignedIn={onSignedIn} />)
      await fillAndSubmit(user)
      await user.click(screen.getByRole('checkbox', { name: 'Trust this device for 30 days' }))
      await user.type(await screen.findByLabelText('Authentication code'), '123456')
      await user.click(screen.getByRole('button', { name: 'Verify' }))
      await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
      expect(devices.trustThisDevice).not.toHaveBeenCalled()
    })

    it('a failed trust call never blocks the sign-in', async () => {
      const user = userEvent.setup()
      mfaUser()
      devices.trustThisDevice.mockRejectedValue(new Error('x'))
      const onSignedIn = vi.fn()
      render(<AdminLoginForm onSignedIn={onSignedIn} />)
      await fillAndSubmit(user)
      await user.type(await screen.findByLabelText('Authentication code'), '123456')
      await user.click(screen.getByRole('button', { name: 'Verify' }))
      await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    })
  })
})
