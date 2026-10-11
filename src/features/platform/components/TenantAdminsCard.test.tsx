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
  StepUpDialog: ({ open, onVerified, onCancel }: { open: boolean; onVerified: () => void; onCancel: () => void }) =>
    open ? (
      <div role="dialog" aria-label="step-up">
        <button onClick={onVerified}>Verify code</button>
        <button onClick={onCancel}>Cancel step-up</button>
      </div>
    ) : null,
}))

const { TenantAdminsCard, mfaResetErrorMessage } = await import('./TenantAdminsCard')

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
    trusted_devices: 0,
  },
]

function Harness() {
  const stepUp = useStepUp()
  return (
    <>
      <TenantAdminsCard restaurantId={RID} admins={admins} run={stepUp.run} />
      {stepUp.dialog}
    </>
  )
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  render(
    <QueryClientProvider client={qc}>
      <Harness />
      <Toaster />
    </QueryClientProvider>,
  )
  return { invalidate }
}

const ok = { profile_id: ADMIN, factors_removed: 1, sessions_revoked: 3, devices_revoked: 2 }

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

  it('requires a reason, explains the effects, runs through step-up and invalidates the tenant', async () => {
    // the mocked step-up prompt sits outside the Radix modal (which sets pointer-events: none on the body)
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const { invalidate } = renderCard()
    h.resetTenantAdminMfa
      .mockRejectedValueOnce(new RpcError('step_up_required'))
      .mockResolvedValueOnce(ok)
    await user.click(screen.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }))
    const dialog = screen.getByRole('dialog', { name: 'Reset authenticator: Selam Bekele' })
    expect(dialog).toHaveTextContent(/removes their authenticator app and every trusted device/)
    expect(dialog).toHaveTextContent(/signs them out/)
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
    expect(await screen.findByText(/Authenticator reset for Selam Bekele/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Reset authenticator/ })).toBeNull())
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['platform', 'tenant', RID] })
  })

  it('shows fixed copy for a refused reset and keeps the dialog open', async () => {
    const user = userEvent.setup()
    renderCard()
    h.resetTenantAdminMfa.mockRejectedValueOnce(new RpcError('invalid_state'))
    await user.click(screen.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }))
    const dialog = screen.getByRole('dialog', { name: /Reset authenticator/ })
    await user.type(within(dialog).getByLabelText(/Reason/), 'Lost phone')
    await user.click(within(dialog).getByRole('button', { name: 'Reset authenticator' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/no authenticator to reset/)
  })
})

describe('mfaResetErrorMessage', () => {
  it('maps every documented code to safe fixed copy', () => {
    for (const code of [
      'unauthorized',
      'permission_denied',
      'step_up_required',
      'mfa_required',
      'not_found',
      'invalid_input',
      'invalid_state',
      'rate_limited',
      'try_later',
      'server_error',
      'network',
    ]) {
      const text = mfaResetErrorMessage(new RpcError(code))
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toContain(code)
    }
    expect(mfaResetErrorMessage(new RpcError('rate_limited'))).toMatch(/Too many requests/)
    expect(mfaResetErrorMessage(new Error('select * from secrets'))).not.toMatch(/secrets/)
  })
})
