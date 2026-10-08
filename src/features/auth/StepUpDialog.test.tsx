import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StepUpDialog } from './StepUpDialog'
import { AuthContext, type AuthValue } from './useAuth'

const h = vi.hoisted(() => ({
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { mfa: { listFactors: h.listFactors, challengeAndVerify: h.challengeAndVerify } } },
}))

const passwordSession = { user: { id: 'u', email: 'owner@example.com', app_metadata: {} } }
const pinSession = {
  user: { id: 'u', email: 'abebe@demo.staff.cafeos.invalid', app_metadata: { staff: true } },
}

function renderDialog(session: unknown = null) {
  const onVerified = vi.fn()
  const onCancel = vi.fn()
  const value = {
    status: 'authenticated',
    session,
    context: {
      user: { id: 'u', first_name: 'A', username: 'a' },
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: [],
      station_ids: [],
    },
    contextStatus: 'ready',
    can: () => false,
    signOut: vi.fn(),
    refreshContext: vi.fn(),
  } as unknown as AuthValue
  render(
    <AuthContext.Provider value={value}>
      <MemoryRouter>
        <StepUpDialog open onVerified={onVerified} onCancel={onCancel} />
      </MemoryRouter>
    </AuthContext.Provider>,
  )
  return { onVerified, onCancel }
}

describe('StepUpDialog', () => {
  beforeEach(() => {
    h.listFactors.mockReset()
    h.challengeAndVerify.mockReset()
  })

  it('an account without an authenticator (PIN-only staff) gets a neutral message and cannot verify', async () => {
    h.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    const { onVerified } = renderDialog()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('An authenticator is required for this action.')
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
    expect(screen.getByLabelText('Authentication code')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(h.challengeAndVerify).not.toHaveBeenCalled()
    expect(onVerified).not.toHaveBeenCalled()
  })

  it('a PIN session without an authenticator gets no link to the Security page', async () => {
    h.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    renderDialog(pinSession)
    expect(await screen.findByRole('alert')).toHaveTextContent('ask your administrator')
    expect(screen.queryByRole('link', { name: /security/i })).not.toBeInTheDocument()
  })

  it('an email + password account without an authenticator is pointed to the Security page', async () => {
    const user = userEvent.setup()
    h.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    const { onCancel } = renderDialog(passwordSession)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Set one up in Security settings')
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
    const link = screen.getByRole('link', { name: 'Open Security settings' })
    expect(link).toHaveAttribute('href', '/r/demo-cafe/settings/security')
    await user.click(link)
    expect(onCancel).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
  })

  it('a failing factor lookup shows the generic message (never a pass)', async () => {
    h.listFactors.mockResolvedValue({ data: null, error: new Error('boom') })
    const { onVerified } = renderDialog()
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.')
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(onVerified).not.toHaveBeenCalled()
  })

  it('a password session whose factor lookup fails gets no "set one up" prompt or link', async () => {
    h.listFactors.mockResolvedValue({ data: null, error: new Error('boom') })
    const { onVerified } = renderDialog(passwordSession)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Something went wrong. Please try again.')
    expect(alert.textContent).not.toMatch(/set one up|security settings/i)
    expect(screen.queryByRole('link', { name: /security/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify' })).toBeDisabled()
    expect(onVerified).not.toHaveBeenCalled()
  })

  it('an enrolled account verifies a 6-digit code and reports success', async () => {
    const user = userEvent.setup()
    h.listFactors.mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
    h.challengeAndVerify.mockResolvedValue({ error: null })
    const { onVerified } = renderDialog()
    const input = screen.getByLabelText('Authentication code')
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(input, '123456')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1))
    expect(h.challengeAndVerify).toHaveBeenCalledWith({ factorId: 'factor-1', code: '123456' })
  })

  it('a wrong code is refused without calling onVerified', async () => {
    const user = userEvent.setup()
    h.listFactors.mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
    h.challengeAndVerify.mockResolvedValue({ error: new Error('invalid') })
    const { onVerified } = renderDialog()
    const input = screen.getByLabelText('Authentication code')
    await waitFor(() => expect(input).toBeEnabled())
    await user.type(input, '000000')
    await user.click(screen.getByRole('button', { name: 'Verify' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work.')
    expect(onVerified).not.toHaveBeenCalled()
  })
})
