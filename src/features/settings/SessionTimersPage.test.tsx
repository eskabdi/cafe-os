import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { SessionTimersPage } from './SessionTimersPage'

const h = vi.hoisted(() => ({
  getSessionTimers: vi.fn(),
  updateSessionTimers: vi.fn(),
  resetSessionTimers: vi.fn(),
  listFactors: vi.fn(),
  challengeAndVerify: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({
  supabase: { auth: { mfa: { listFactors: h.listFactors, challengeAndVerify: h.challengeAndVerify } } },
}))
vi.mock('@/lib/supabase/rpc', () => {
  class RpcError extends Error {
    readonly code: string
    readonly detail?: string
    constructor(code: string, detail?: string) {
      super(code)
      this.code = code
      this.detail = detail
    }
  }
  return {
    getSessionTimers: h.getSessionTimers,
    updateSessionTimers: h.updateSessionTimers,
    resetSessionTimers: h.resetSessionTimers,
    RpcError,
  }
})

const refreshContext = vi.fn()
const stored = { idle_warning_seconds: 20, signout_seconds: 60, pin_pad_idle_seconds: 90 }

function renderPage(perms = ['settings.session_timers']) {
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: {
      user: { id: 'admin', first_name: 'Admin', username: 'admin' },
      restaurant: { id: 'r', name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: perms,
      station_ids: [],
    },
    contextStatus: 'ready',
    can: (p) => perms.includes(p),
    signOut: vi.fn(),
    refreshContext,
  }
  render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SessionTimersPage />
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

type User = ReturnType<typeof userEvent.setup>
const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement
async function setField(user: User, label: RegExp, value: string) {
  await user.clear(field(label))
  if (value) await user.type(field(label), value)
}
const rpcError = async (code: string, detail?: string) => {
  const { RpcError } = await import('@/lib/supabase/rpc')
  return new (RpcError as unknown as new (c: string, d?: string) => Error)(code, detail)
}

beforeEach(() => {
  h.getSessionTimers.mockReset().mockResolvedValue(stored)
  h.updateSessionTimers.mockReset()
  h.resetSessionTimers.mockReset()
  h.listFactors.mockReset().mockResolvedValue({ data: { totp: [{ id: 'factor-1' }] }, error: null })
  h.challengeAndVerify.mockReset()
  refreshContext.mockClear()
})

describe('SessionTimersPage', () => {
  it('is hidden without settings.session_timers and calls nothing', () => {
    renderPage([])
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument()
    expect(h.getSessionTimers).not.toHaveBeenCalled()
  })

  it('loads the stored values and explains the warning window (signout - warn)', async () => {
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    expect(field(/Sign out after/).value).toBe('60')
    expect(field(/Terminal PIN pad timeout/).value).toBe('90')
    const preview = screen.getByTestId('timers-preview')
    expect(preview).toHaveTextContent('After 20 seconds without activity')
    expect(preview).toHaveTextContent('visible for 40 seconds')
    expect(preview).toHaveTextContent('after 90 seconds')
  })

  it('validates locally with the same bounds and does not call the server', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await setField(user, /Show the warning after/, '60')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('The warning must appear before the sign-out time.')).toBeInTheDocument()
    expect(screen.getByTestId('timers-preview')).toHaveTextContent('Enter valid values')

    await setField(user, /Show the warning after/, '20')
    await setField(user, /Sign out after/, '901')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Sign-out can be at most 900 seconds (15 minutes).')).toBeInTheDocument()

    await setField(user, /Sign out after/, '60')
    await setField(user, /Terminal PIN pad timeout/, '')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Enter the PIN pad time in whole seconds.')).toBeInTheDocument()
    expect(h.updateSessionTimers).not.toHaveBeenCalled()
  })

  it('saves, toasts and refreshes the session context', async () => {
    const user = userEvent.setup()
    const next = { idle_warning_seconds: 30, signout_seconds: 120, pin_pad_idle_seconds: 45 }
    h.updateSessionTimers.mockResolvedValue(next)
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await setField(user, /Show the warning after/, '30')
    await setField(user, /Sign out after/, '120')
    await setField(user, /Terminal PIN pad timeout/, '45')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.updateSessionTimers).toHaveBeenCalledTimes(1))
    expect(h.updateSessionTimers.mock.calls[0]?.[0]).toEqual(next)
    expect(await screen.findByText('Session timers saved')).toBeInTheDocument()
    expect(refreshContext).toHaveBeenCalledTimes(1)
  })

  it('resets to 15 / 30 / 60 after confirmation', async () => {
    const user = userEvent.setup()
    h.resetSessionTimers.mockResolvedValue({
      idle_warning_seconds: 15,
      signout_seconds: 30,
      pin_pad_idle_seconds: 60,
    })
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(
      'Warning after 15 seconds, sign-out after 30 seconds, terminal PIN pad after 60 seconds.',
    )
    await user.click(within(dialog).getByRole('button', { name: 'Reset' }))
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('15'))
    expect(field(/Sign out after/).value).toBe('30')
    expect(field(/Terminal PIN pad timeout/).value).toBe('60')
    expect(h.resetSessionTimers).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Session timers reset to the defaults')).toBeInTheDocument()
  })

  it('invalid_input marks the field named by the server', async () => {
    const user = userEvent.setup()
    h.updateSessionTimers.mockRejectedValue(await rpcError('invalid_input', 'pin_pad_idle_seconds'))
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(
      await screen.findByText('The PIN pad time must be between 15 and 300 seconds.'),
    ).toBeInTheDocument()
    expect(field(/Terminal PIN pad timeout/)).toHaveAttribute('aria-invalid', 'true')
  })

  it.each([
    ['permission_denied', 'You do not have permission to change these settings.'],
    ['tenant_read_only', 'This restaurant account cannot make changes right now.'],
    ['tenant_suspended', 'This restaurant account cannot make changes right now.'],
    ['invalid_input', 'Some values are not allowed. Check the fields and try again.'],
    ['rpc_failed', 'Something went wrong. Please try again.'],
  ])('maps %s to safe copy', async (code, message) => {
    const user = userEvent.setup()
    h.updateSessionTimers.mockRejectedValue(await rpcError(code))
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('mfa_required opens the step-up; a verified code retries the save', async () => {
    const user = userEvent.setup()
    h.updateSessionTimers.mockRejectedValueOnce(await rpcError('mfa_required')).mockResolvedValueOnce(stored)
    h.challengeAndVerify
      .mockResolvedValueOnce({ error: { message: 'bad' } })
      .mockResolvedValueOnce({ error: null })
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify it is you' })
    expect(dialog).toHaveTextContent('Verify with your authenticator to continue.')
    const code = await within(dialog).findByLabelText('Authentication code')
    await waitFor(() => expect(code).toBeEnabled())

    await user.type(code, '123456')
    await user.click(within(dialog).getByRole('button', { name: 'Verify' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That code did not work.')
    expect(h.updateSessionTimers).toHaveBeenCalledTimes(1)

    await user.type(code, '654321')
    await user.click(within(dialog).getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(h.updateSessionTimers).toHaveBeenCalledTimes(2))
    expect(h.challengeAndVerify).toHaveBeenLastCalledWith({ factorId: 'factor-1', code: '654321' })
    expect(await screen.findByText('Session timers saved')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('mfa_required for reset, cancelled: neutral message, nothing retried', async () => {
    const user = userEvent.setup()
    h.resetSessionTimers.mockRejectedValue(await rpcError('mfa_required'))
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Reset' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify it is you' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByText('Verify with your authenticator to continue.')).toBeInTheDocument()
    expect(h.resetSessionTimers).toHaveBeenCalledTimes(1)
  })

  it('step-up without an enrolled authenticator explains neutrally', async () => {
    const user = userEvent.setup()
    h.listFactors.mockResolvedValue({ data: { totp: [] }, error: null })
    h.updateSessionTimers.mockRejectedValue(await rpcError('mfa_required'))
    renderPage()
    await waitFor(() => expect(field(/Show the warning after/).value).toBe('20'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog', { name: 'Verify it is you' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'An authenticator is required for this action',
    )
    expect(within(dialog).getByRole('button', { name: 'Verify' })).toBeDisabled()
  })
})
