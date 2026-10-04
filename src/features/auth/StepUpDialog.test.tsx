import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StepUpDialog } from './StepUpDialog'

const h = vi.hoisted(() => ({
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { mfa: { listFactors: h.listFactors, challengeAndVerify: h.challengeAndVerify } } },
}))

function renderDialog() {
  const onVerified = vi.fn()
  const onCancel = vi.fn()
  render(<StepUpDialog open onVerified={onVerified} onCancel={onCancel} />)
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

  it('a failing factor lookup shows the same neutral message (never a pass)', async () => {
    h.listFactors.mockResolvedValue({ data: null, error: new Error('boom') })
    const { onVerified } = renderDialog()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An authenticator is required for this action.',
    )
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
