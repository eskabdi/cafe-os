import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { PinApprovalsPage } from './PinApprovalsPage'

const h = vi.hoisted(() => ({
  listPendingPinChanges: vi.fn(),
  approvePinChange: vi.fn(),
  rejectPinChange: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/rpc', () => {
  class RpcError extends Error {
    readonly code: string
    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
  return { ...h, RpcError }
})

const ABEBE = '11111111-1111-4111-8111-111111111111'
const SARA = '22222222-2222-4222-8222-222222222222'
const rows = [
  {
    profile_id: ABEBE,
    user_name: 'Abebe Kebede',
    role_label: 'Runner',
    requested_at: '2026-10-04T08:00:00Z',
  },
  { profile_id: SARA, user_name: '<b>Sara</b>', role_label: 'Grill Cook', requested_at: null },
]

function renderPage(perms = ['users.manage']) {
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
    refreshContext: vi.fn(),
  }
  render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <PinApprovalsPage />
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

async function decide(user: ReturnType<typeof userEvent.setup>, rowButton: string, confirmButton: string) {
  await user.click(await screen.findByRole('button', { name: rowButton }))
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: confirmButton }))
}

beforeEach(() => {
  h.listPendingPinChanges.mockReset().mockResolvedValue(rows)
  h.approvePinChange.mockReset()
  h.rejectPinChange.mockReset()
})

describe('PinApprovalsPage', () => {
  it('is hidden without users.manage and calls nothing', () => {
    renderPage([])
    expect(screen.getByText('You do not have permission to view this page.')).toBeInTheDocument()
    expect(h.listPendingPinChanges).not.toHaveBeenCalled()
  })

  it('lists pending changes with server-provided names and role labels as text', async () => {
    renderPage()
    expect(await screen.findByText('Abebe Kebede')).toBeInTheDocument()
    // local-time rendering, Arabic numerals
    expect(screen.getByText(/^Runner · Requested 2026-10-0[34] [0-9]{2}:[0-9]{2}$/)).toBeInTheDocument()
    expect(screen.getByText('<b>Sara</b>')).toBeInTheDocument()
    expect(screen.getByText('Grill Cook')).toBeInTheDocument()
    expect(document.querySelector('main b')).toBeNull()
  })

  it('shows an empty state', async () => {
    h.listPendingPinChanges.mockResolvedValue([])
    renderPage()
    expect(await screen.findByText('No PIN changes are waiting for approval.')).toBeInTheDocument()
  })

  it('approves only after confirmation, toasts and refreshes the list', async () => {
    const user = userEvent.setup()
    h.approvePinChange.mockResolvedValue({ profile_id: ABEBE, status: 'approved' })
    renderPage()
    await user.click(await screen.findByRole('button', { name: 'Approve Abebe Kebede' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Approve the new PIN for Abebe Kebede?')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(h.approvePinChange).not.toHaveBeenCalled()

    await decide(user, 'Approve Abebe Kebede', 'Approve PIN')
    expect(h.approvePinChange).toHaveBeenCalledWith(ABEBE)
    expect(await screen.findByText('Approved the new PIN for Abebe Kebede')).toBeInTheDocument()
    await waitFor(() => expect(h.listPendingPinChanges).toHaveBeenCalledTimes(2))
  })

  it('rejects after confirmation', async () => {
    const user = userEvent.setup()
    h.rejectPinChange.mockResolvedValue({ profile_id: SARA, status: 'rejected' })
    renderPage()
    await decide(user, 'Reject <b>Sara</b>', 'Reject PIN')
    expect(h.rejectPinChange).toHaveBeenCalledWith(SARA)
    expect(h.approvePinChange).not.toHaveBeenCalled()
    expect(await screen.findByText('Rejected the new PIN for <b>Sara</b>')).toBeInTheDocument()
  })

  it('mfa_required: neutral step-up message, nothing invalidated', async () => {
    const user = userEvent.setup()
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.approvePinChange.mockRejectedValue(new RpcError('mfa_required'))
    renderPage()
    await decide(user, 'Approve Abebe Kebede', 'Approve PIN')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Verify with your authenticator to continue.')
    expect(alert.textContent).not.toMatch(/mfa|aal/i)
    expect(h.listPendingPinChanges).toHaveBeenCalledTimes(1)
  })

  it('not_found: explains and refreshes the list', async () => {
    const user = userEvent.setup()
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.rejectPinChange.mockRejectedValue(new RpcError('not_found'))
    renderPage()
    await decide(user, 'Reject Abebe Kebede', 'Reject PIN')
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This request is no longer waiting for approval.',
    )
    await waitFor(() => expect(h.listPendingPinChanges).toHaveBeenCalledTimes(2))
  })

  it.each([
    ['permission_escalation', 'You do not have permission to decide on this request.'],
    ['tenant_read_only', 'This restaurant account cannot make changes right now.'],
    ['some_internal_code', 'Something went wrong. Please try again.'],
  ])('maps %s to safe copy', async (code, message) => {
    const user = userEvent.setup()
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.approvePinChange.mockRejectedValue(new RpcError(code))
    renderPage()
    await decide(user, 'Approve Abebe Kebede', 'Approve PIN')
    expect(await screen.findByRole('alert')).toHaveTextContent(message)
  })

  it('a list error is shown with safe copy', async () => {
    const { RpcError } = await import('@/lib/supabase/rpc')
    h.listPendingPinChanges.mockRejectedValue(new RpcError('permission_denied'))
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to decide on this request.',
    )
  })
})
