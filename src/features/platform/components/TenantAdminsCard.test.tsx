import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStepUp } from '@/features/auth/useStepUp'
import { RpcError } from '@/lib/supabase/rpc'
import type { TenantAdminRow } from '@/lib/supabase/platform'
import type * as EdgeModule from '@/lib/supabase/edge-functions'

const h = vi.hoisted(() => ({ resetTenantAdminMfa: vi.fn() }))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/edge-functions', async (orig) => ({
  ...(await orig<typeof EdgeModule>()),
  resetTenantAdminMfa: h.resetTenantAdminMfa,
}))
vi.mock('@/features/auth/StepUpDialog', () => ({
  StepUpDialog: ({
    open,
    onVerified,
    onCancel,
  }: {
    open: boolean
    onVerified: () => void
    onCancel: () => void
  }) =>
    open ? (
      <div role="dialog" aria-label="step-up">
        <button onClick={onVerified}>Verify code</button>
        <button onClick={onCancel}>Cancel step-up</button>
      </div>
    ) : null,
}))

const { TenantAdminsCard, mfaResetErrorMessage, mfaResetWarnings } = await import('./TenantAdminsCard')

const RID = '99999999-9999-4999-8999-999999999999'
const ADMIN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const admins: TenantAdminRow[] = [
  {
    profile_id: ADMIN,
    first_name: 'Selam',
    middle_name: 'Bekele',
    last_name: 'Tadesse',
    email: 'selam@example.com',
    is_active: true,
    mfa_enrolled: true,
    mfa_reset_pending: false,
    trusted_devices: 2,
  },
  {
    profile_id: OTHER,
    first_name: 'Dawit',
    middle_name: null,
    last_name: 'Alemu',
    email: 'dawit@example.com',
    is_active: false,
    mfa_enrolled: false,
    mfa_reset_pending: false,
    trusted_devices: 0,
  },
]

function Harness({ rows = admins }: { rows?: TenantAdminRow[] }) {
  const stepUp = useStepUp()
  return (
    <>
      <TenantAdminsCard restaurantId={RID} admins={rows} run={stepUp.run} />
      {stepUp.dialog}
    </>
  )
}

function renderCard(rows?: TenantAdminRow[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <Harness rows={rows} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { invalidate }
}

const ok = {
  profile_id: ADMIN,
  factors_removed: 1,
  sessions_revoked: 3,
  devices_revoked: 2,
  password_rotated: true as const,
  recovery_sent: true,
}

beforeEach(() => {
  h.resetTenantAdminMfa.mockReset()
})

describe('Tenant Admins card', () => {
  it('lists admins with the Ethiopian full name, e-mail, status and MFA posture', () => {
    renderCard()
    const list = screen.getByRole('list', { name: 'Tenant Admins' })
    const selam = within(list).getByRole('listitem', { name: 'Selam Bekele Tadesse' })
    expect(selam).toHaveTextContent('selam@example.com')
    expect(selam).toHaveTextContent('Authenticator:enrolled')
    expect(selam).toHaveTextContent('Trusted devices:2')
    const dawit = within(list).getByRole('listitem', { name: 'Dawit Alemu' })
    expect(dawit).toHaveTextContent('not enrolled')
    // reset is offered only for an enrolled admin
    expect(within(dawit).queryByRole('button', { name: /Reset authenticator/ })).toBeNull()
  })

  it('offers no reset for an inactive admin (the server only resets an active Tenant Admin)', () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <TenantAdminsCard
          restaurantId={RID}
          admins={[{ ...(admins[0] as TenantAdminRow), is_active: false }]}
          run={(fn) => fn()}
        />
      </QueryClientProvider>,
    )
    expect(screen.queryByRole('button', { name: /Reset authenticator/ })).toBeNull()
  })

  it('requires a reason, explains the effects, runs through step-up and invalidates the tenant', async () => {
    // the mocked step-up prompt sits outside the Radix modal (which sets pointer-events: none on the body)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { invalidate } = renderCard()
    h.resetTenantAdminMfa.mockRejectedValueOnce(new RpcError('step_up_required')).mockResolvedValueOnce(ok)
    await user.click(screen.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset authenticator: Selam Bekele' })
    expect(dialog).toHaveTextContent(/removes their authenticator app and every trusted device/)
    expect(dialog).toHaveTextContent(/signs them out/)
    expect(dialog).toHaveTextContent(/replaces their password with a random one/)
    expect(dialog).toHaveTextContent(/password-reset link/)
    expect(dialog).toHaveTextContent(/enrol a new authenticator/)
    expect(dialog).toHaveTextContent(/audit log/)

    await user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }))
    expect(await within(dialog).findByText('Enter a reason of 3 to 500 characters.')).toBeInTheDocument()
    expect(h.resetTenantAdminMfa).not.toHaveBeenCalled()

    await user.type(within(dialog).getByLabelText(/Reason/), 'Lost phone, verified by call')
    await user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }))
    await user.click(await screen.findByRole('button', { name: 'Verify code' }))

    await waitFor(() => expect(h.resetTenantAdminMfa).toHaveBeenCalledTimes(2))
    expect(h.resetTenantAdminMfa).toHaveBeenLastCalledWith({
      restaurantId: RID,
      profileId: ADMIN,
      reason: 'Lost phone, verified by call',
    })
    expect(await screen.findByText(/Authenticator reset for Selam Bekele/)).toHaveTextContent(
      /They were signed out\. A password-reset link was e-mailed to them\./,
    )
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Reset authenticator/ })).toBeNull())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['platform', 'tenant', RID] })
  })

  it('warns instead of claiming a sign-out when it could not be confirmed, and when no recovery e-mail went out', async () => {
    const user = userEvent.setup()
    renderCard()
    h.resetTenantAdminMfa.mockResolvedValueOnce({ ...ok, sessions_revoked: null, recovery_sent: false })
    await user.click(screen.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }))
    const dialog = screen.getByRole('dialog', { name: /Reset authenticator/ })
    await user.type(within(dialog).getByLabelText(/Reason/), 'Lost phone')
    await user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }))
    const done = await screen.findByText(/Authenticator reset for Selam Bekele/)
    expect(done).not.toHaveTextContent(/signed out/)
    expect(done).not.toHaveTextContent(/e-mailed/)
    expect(
      await screen.findByText(
        'Sign-out could not be confirmed; their old sessions can no longer pass the authenticator check.',
      ),
    ).toBeInTheDocument()
    expect(await screen.findByText(/password-reset e-mail could not be sent/)).toBeInTheDocument()
  })

  it('offers "Finish reset" for a half-done reset and sends the same request', async () => {
    const user = userEvent.setup()
    const half: TenantAdminRow = {
      ...(admins[0] as TenantAdminRow),
      mfa_enrolled: false,
      mfa_reset_pending: true,
      trusted_devices: 1,
    }
    renderCard([half])
    const row = screen.getByRole('listitem', { name: 'Selam Bekele Tadesse' })
    expect(row).toHaveTextContent('Authenticator:reset not finished')
    expect(within(row).queryByRole('button', { name: /^Reset authenticator/ })).toBeNull()
    h.resetTenantAdminMfa.mockResolvedValueOnce({ ...ok, factors_removed: 0 })
    await user.click(
      within(row).getByRole('button', { name: 'Finish authenticator reset for Selam Bekele Tadesse' }),
    )
    const dialog = screen.getByRole('dialog', { name: 'Finish authenticator reset: Selam Bekele' })
    expect(dialog).toHaveTextContent(/stopped half-way/)
    await user.type(within(dialog).getByLabelText(/Reason/), 'Finish the reset')
    await user.click(within(dialog).getByRole('button', { name: 'Finish reset' }))
    await waitFor(() =>
      expect(h.resetTenantAdminMfa).toHaveBeenCalledWith({
        restaurantId: RID,
        profileId: ADMIN,
        reason: 'Finish the reset',
      }),
    )
  })

  it('offers no action for an admin who never enrolled and has nothing pending', () => {
    renderCard([{ ...(admins[0] as TenantAdminRow), mfa_enrolled: false }])
    expect(screen.queryByRole('button', { name: /Reset authenticator|Finish/ })).toBeNull()
  })

  it('shows fixed copy for a refused reset and keeps the dialog open', async () => {
    const user = userEvent.setup()
    renderCard()
    h.resetTenantAdminMfa.mockRejectedValueOnce(new RpcError('no_factor'))
    await user.click(screen.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }))
    const dialog = screen.getByRole('dialog', { name: /Reset authenticator/ })
    await user.type(within(dialog).getByLabelText(/Reason/), 'Lost phone')
    await user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This admin has no authenticator to reset any more. Refresh.',
    )
  })
})

describe('mfaResetErrorMessage', () => {
  it('maps every code the Edge Function emits to safe fixed copy', () => {
    for (const code of [
      'invalid_request',
      'unauthorized',
      'forbidden',
      'mfa_required',
      'step_up_required',
      'not_found',
      'no_factor',
      'reset_expired',
      'try_later',
      'server_error',
      'network',
    ]) {
      const text = mfaResetErrorMessage(new RpcError(code))
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toContain(code)
    }
    expect(mfaResetErrorMessage(new RpcError('no_factor'))).toBe(
      'This admin has no authenticator to reset any more. Refresh.',
    )
    expect(mfaResetErrorMessage(new RpcError('invalid_request'))).toBe(
      'Enter a reason of 3 to 500 characters.',
    )
    expect(mfaResetErrorMessage(new RpcError('reset_expired'))).toMatch(/did not finish in time/)
    expect(mfaResetErrorMessage(new RpcError('try_later'))).toMatch(/Too many requests/)
    expect(mfaResetErrorMessage(new Error('select * from secrets'))).not.toMatch(/secrets/)
  })
})

describe('mfaResetWarnings', () => {
  it('is empty for a confirmed sign-out and a sent e-mail', () => {
    expect(mfaResetWarnings({ sessions_revoked: 0, recovery_sent: true })).toEqual([])
  })
  it('flags an unconfirmed sign-out and an unsent e-mail', () => {
    expect(mfaResetWarnings({ sessions_revoked: null, recovery_sent: false })).toHaveLength(2)
  })
})
