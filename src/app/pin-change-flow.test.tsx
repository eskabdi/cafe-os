import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// End-to-end wiring of the forced PIN change inside the real route tree: AuthProvider -> RequireAuth -> PinChangeGate ->
// TenantShell, plus the NotificationsListener. Supabase Auth, Realtime and the RPCs are mocked at the module boundary.

const UID = '11111111-1111-4111-8111-111111111111'

const h = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  markNotificationRead: vi.fn(),
  changePin: vi.fn(),
  realtime: null as null | ((change: { new: unknown }) => void),
  subscribed: null as null | ((status: string) => void),
  removeChannel: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('@/lib/supabase/client', () => {
  const channel = {
    on: (_t: string, _f: unknown, cb: (change: { new: unknown }) => void) => {
      h.realtime = cb
      return channel
    },
    subscribe: (cb: (status: string) => void) => {
      h.subscribed = cb
      return channel
    },
  }
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) query[m] = () => query
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve)
  return {
    supabase: {
      auth: {
        onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
          queueMicrotask(() => cb('INITIAL_SESSION', { user: { id: UID }, access_token: 't' }))
          return { data: { subscription: { unsubscribe: vi.fn() } } }
        },
        signOut: h.signOut,
      },
      channel: () => channel,
      removeChannel: h.removeChannel,
      from: () => query,
    },
  }
})
vi.mock('@/lib/supabase/rpc', () => ({
  getSessionContext: h.getSessionContext,
  markNotificationRead: h.markNotificationRead,
  isPlatformSuperAdmin: vi.fn(),
  resolveTenantSlug: vi.fn().mockResolvedValue(null),
  listPendingPinChanges: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/supabase/pin-change', () => ({ changePin: h.changePin }))

import { routes } from './routes'

type Status = 'none' | 'required' | 'pending_approval'
const ctx = (status: Status) => ({
  user: { id: UID, first_name: 'Abebe', short_name: 'Abebe Kebede', username: 'abebe' },
  restaurant: { id: 'r-1', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
  role: { id: 'role-1', name: 'Some Role', system_key: null, is_active: true },
  permissions: status === 'none' ? ['orders.view'] : [],
  station_ids: [],
  must_change_pin: status === 'required',
  pin_change_status: status,
  pin_length: 4,
})

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>,
  )
  return router
}

const insert = (kind: string) =>
  act(() =>
    h.realtime?.({
      new: {
        id: `00000000-0000-4000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
        recipient_id: UID,
        kind,
        payload: { profile_id: UID, user_name: 'Abebe Kebede', at: '2026-10-04T08:00:00Z' },
        created_at: '2026-10-04T08:00:00Z',
        read_at: null,
      },
    }),
  )

beforeEach(() => {
  h.getSessionContext.mockReset()
  h.markNotificationRead.mockReset().mockResolvedValue(undefined)
  h.changePin.mockReset()
  h.realtime = null
})

describe('forced PIN change flow (route tree)', () => {
  it('required: a deep link lands on Change PIN; after the change the user waits; approval returns them home', async () => {
    const user = userEvent.setup()
    h.getSessionContext.mockResolvedValueOnce(ctx('required'))
    const router = renderAt('/r/demo-cafe/orders')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/change-pin'))
    expect(await screen.findByRole('link', { name: 'Change PIN' })).toBeInTheDocument()

    h.changePin.mockResolvedValue({ ok: true, pendingApproval: true, otherSessionsRevoked: true })
    for (const [pin, key] of [
      ['4829', 'Next'],
      ['7391', 'Next'],
      ['7391', 'Change PIN'],
    ] as const) {
      for (const d of pin) await user.click(screen.getByRole('button', { name: `Digit ${d}` }))
      await user.click(screen.getByRole('button', { name: key }))
    }
    expect(await screen.findByRole('heading', { name: 'Your PIN has been changed' })).toBeInTheDocument()

    h.getSessionContext.mockResolvedValueOnce(ctx('pending_approval'))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/pin-pending'))
    expect(screen.getByRole('heading', { name: 'Waiting for manager approval' })).toBeInTheDocument()

    // live: the approval notification arrives over Realtime
    h.getSessionContext.mockResolvedValueOnce(ctx('none'))
    await insert('security.pin_change_approved')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe'))
    expect(await screen.findByText('Your new PIN was approved')).toBeInTheDocument()
    expect(h.getSessionContext).toHaveBeenCalledTimes(3)
  })

  it('pending: a rejection over Realtime sends the user back to Change PIN with a neutral explanation', async () => {
    h.getSessionContext.mockResolvedValueOnce(ctx('pending_approval'))
    const router = renderAt('/r/demo-cafe')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/pin-pending'))
    await waitFor(() => expect(h.realtime).not.toBeNull())

    h.getSessionContext.mockResolvedValueOnce(ctx('required'))
    await insert('security.pin_change_rejected')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/change-pin'))
    expect(
      await screen.findByText('Your manager did not approve your new PIN. Please choose a different PIN.'),
    ).toBeInTheDocument()
    expect(await screen.findByText('Your new PIN was not approved')).toBeInTheDocument()
  })

  it('pending: the waiting screen stays mounted during the refresh (no loading flash)', async () => {
    h.getSessionContext.mockResolvedValueOnce(ctx('pending_approval'))
    const router = renderAt('/r/demo-cafe/pin-pending')
    await screen.findByRole('heading', { name: 'Waiting for manager approval' })
    let release!: (v: unknown) => void
    h.getSessionContext.mockReturnValueOnce(new Promise((r) => (release = r)))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check again' }))
    expect(screen.getByRole('heading', { name: 'Waiting for manager approval' })).toBeInTheDocument()
    await act(async () => release(ctx('pending_approval')))
    expect(router.state.location.pathname).toBe('/r/demo-cafe/pin-pending')
  })

  it('none: tenant routes render normally', async () => {
    h.getSessionContext.mockResolvedValueOnce(ctx('none'))
    const router = renderAt('/r/demo-cafe/pin-pending')
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe'))
    expect(await screen.findByTestId('tenant-slug')).toHaveTextContent('demo-cafe')
    expect(screen.queryByRole('link', { name: 'Change PIN' })).toBeNull()
  })
})
