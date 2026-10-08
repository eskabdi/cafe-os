import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter, type RouteObject } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import type { SessionContext } from '@/lib/supabase/rpc'
import type * as StationsModule from '@/lib/supabase/stations'

const h = vi.hoisted(() => ({
  fetchActiveStations: vi.fn(),
  subscribeToStations: vi.fn(() => () => {}),
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/stations', async (orig) => ({
  ...(await orig<typeof StationsModule>()),
  fetchActiveStations: h.fetchActiveStations,
  subscribeToStations: h.subscribeToStations,
}))

const { TenantShell } = await import('@/features/tenant/TenantShell')
const { default: TenantHome, TenantNotFound } = await import('@/features/tenant/TenantRoutes')
const { StationKDS } = await import('@/features/stations/StationKDS')
const { RequireStationAccess } = await import('./RouteGuards')
const { CONTEXT_REFRESH_DEBOUNCE_MS } = await import('@/features/stations/StationsProvider')
const { placeholderModuleRoutes } = await import('./module-routes')

const RID = '99999999-9999-4999-8999-999999999999'
const ROLE = '88888888-8888-4888-8888-888888888888'
const S_A = '11111111-1111-4111-8111-111111111111'
const S_B = '22222222-2222-4222-8222-222222222222'
const S_C = '33333333-3333-4333-8333-333333333333'

const STATIONS = [
  { id: S_A, name: 'Station One', color: '#0f766e', icon: 'coffee', sort_order: 1, is_active: true },
  { id: S_B, name: 'Station Two', color: null, icon: null, sort_order: 2, is_active: true },
  { id: S_C, name: 'Station Three', color: '#7c3aed', icon: 'pizza', sort_order: 3, is_active: true },
]

function ctx(perms: string[], stationIds: string[] = [], over: Partial<SessionContext> = {}): SessionContext {
  return {
    user: { id: 'u-1', first_name: 'Abebe', short_name: 'Abebe Kebede', username: 'abebe' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: ROLE, name: 'Any Role', system_key: null, is_active: true },
    permissions: perms,
    station_ids: stationIds,
    pin_change_status: 'none',
    ...over,
  }
}

const PIN_SESSION = {
  user: { email: 'x.staff.cafeos.invalid', app_metadata: { staff: true } },
} as unknown as Session
const ADMIN_SESSION = { user: { email: 'owner@example.com', app_metadata: {} } } as unknown as Session

function auth(context: SessionContext, session: Session = PIN_SESSION): AuthValue {
  return {
    status: 'authenticated',
    session,
    context,
    contextStatus: 'ready',
    can: (p) => context.permissions.includes(p),
    signOut: vi.fn().mockResolvedValue(undefined),
    refreshContext: vi.fn(),
  }
}

const routes: RouteObject[] = [
  {
    path: '/r/:slug',
    element: <TenantShell />,
    children: [
      ...placeholderModuleRoutes(),
      {
        path: 'stations/:stationId',
        element: (
          <RequireStationAccess>
            <StationKDS />
          </RequireStationAccess>
        ),
      },
      { index: true, element: <TenantHome /> },
      { path: '*', element: <TenantNotFound /> },
    ],
  },
]

function renderAt(path: string, value: AuthValue) {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
  return router
}

const mainNav = () => screen.getByRole('navigation', { name: 'Main' })

beforeEach(() => {
  h.fetchActiveStations.mockReset().mockResolvedValue(STATIONS)
  h.subscribeToStations.mockClear()
})

describe('permission-driven navigation', () => {
  it('lists only the modules whose permission the user holds', () => {
    renderAt('/r/demo-cafe', auth(ctx(['orders.create', 'menu.view'])))
    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'POS' })).toHaveAttribute('href', '/r/demo-cafe/pos')
    expect(nav.getByRole('link', { name: 'Menu' })).toHaveAttribute('href', '/r/demo-cafe/menu')
    for (const hidden of [
      'Cashier',
      'Dashboard',
      'Inventory',
      'Installments',
      'Day close',
      'Settings',
      'Terminals',
    ]) {
      expect(nav.queryByRole('link', { name: hidden })).toBeNull()
    }
  })

  it('shows every catalogue module to a holder of all permissions', () => {
    const all = [
      'dashboard.view',
      'orders.create',
      'payments.create',
      'vouchers.view',
      'menu.view',
      'inventory.view',
      'day_close.execute',
      'settings.manage',
      'kiosks.manage',
    ]
    renderAt('/r/demo-cafe', auth(ctx(all)))
    const nav = within(mainNav())
    for (const label of [
      'Dashboard',
      'POS',
      'Cashier',
      'Installments',
      'Menu',
      'Inventory',
      'Day close',
      'Settings',
      'Terminals',
    ]) {
      expect(nav.getByRole('link', { name: label })).toBeInTheDocument()
    }
  })

  it('keeps the account link rules (Security only for Supabase Auth sessions)', () => {
    renderAt('/r/demo-cafe', auth(ctx(['users.manage', 'settings.session_timers']), ADMIN_SESSION))
    const nav = within(mainNav())
    expect(nav.getByRole('link', { name: 'PIN approvals' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'Session timers' })).toBeInTheDocument()
    expect(nav.getByRole('link', { name: 'Security' })).toBeInTheDocument()
    expect(nav.queryByRole('link', { name: 'Change PIN' })).toBeNull()
  })

  it('a PIN session never sees Security', () => {
    renderAt('/r/demo-cafe', auth(ctx(['users.manage'])))
    expect(within(mainNav()).queryByRole('link', { name: 'Security' })).toBeNull()
  })
})

describe('dynamic station navigation', () => {
  it('lists only the stations in the user station access, linking to the generic board', async () => {
    renderAt('/r/demo-cafe', auth(ctx(['orders.view'], [S_A, S_C])))
    const nav = within(mainNav())
    const one = await nav.findByRole('link', { name: 'Station One' })
    expect(nav.getByRole('list', { name: 'Stations' })).toContainElement(one)
    expect(one).toHaveAttribute('href', `/r/demo-cafe/stations/${S_A}`)
    expect(nav.getByRole('link', { name: 'Station Three' })).toHaveAttribute(
      'href',
      `/r/demo-cafe/stations/${S_C}`,
    )
    expect(nav.queryByRole('link', { name: 'Station Two' })).toBeNull()
    // colour comes from the row
    expect(one.querySelector('span[style]')).toHaveStyle({ backgroundColor: '#0f766e' })
    expect(h.subscribeToStations).toHaveBeenCalledWith(RID, ROLE, expect.any(Object))
  })

  it('without the board permission, stations are neither fetched nor listed', () => {
    renderAt('/r/demo-cafe', auth(ctx(['menu.view'], [S_A])))
    expect(screen.queryByRole('list', { name: 'Stations' })).toBeNull()
    expect(h.fetchActiveStations).not.toHaveBeenCalled()
  })

  it('empty access shows a neutral empty state', async () => {
    renderAt('/r/demo-cafe', auth(ctx(['orders.view'], [])))
    expect(await screen.findByText('No stations assigned to you.')).toBeInTheDocument()
  })

  it('a failed load shows a safe message and retries', async () => {
    h.fetchActiveStations.mockRejectedValueOnce(new Error('relation "stations" SQL detail'))
    renderAt('/r/demo-cafe', auth(ctx(['orders.view'], [S_A])))
    expect(await screen.findByText('Stations could not be loaded.')).toBeInTheDocument()
    expect(screen.queryByText(/SQL/)).toBeNull()
    await userEvent.setup().click(within(mainNav()).getByRole('button', { name: 'Try again' }))
    expect(await within(mainNav()).findByRole('link', { name: 'Station One' })).toBeInTheDocument()
  })

  it('uses ONE Realtime subscription for sidebar, drawer and board', async () => {
    const user = userEvent.setup()
    renderAt(`/r/demo-cafe/stations/${S_A}`, auth(ctx(['orders.view'], [S_A])))
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await screen.findByRole('dialog', { name: 'Navigation' })
    expect(h.subscribeToStations).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of stations / access events into one context refresh', async () => {
    const value = auth(ctx(['orders.view'], [S_A]))
    renderAt('/r/demo-cafe', value)
    await within(mainNav()).findByRole('link', { name: 'Station One' })
    const handlers = (h.subscribeToStations.mock.calls as unknown as unknown[][])[0]?.[2] as {
      onStationsChange: () => void
      onAccessChange: () => void
    }
    vi.useFakeTimers()
    try {
      handlers.onStationsChange()
      handlers.onAccessChange()
      handlers.onStationsChange()
      handlers.onAccessChange()
      expect(value.refreshContext).not.toHaveBeenCalled()
      vi.advanceTimersByTime(CONTEXT_REFRESH_DEBOUNCE_MS + 10)
      expect(value.refreshContext).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('route guards', () => {
  it('a permitted placeholder module renders an accessible coming-soon page', async () => {
    renderAt('/r/demo-cafe/cashier', auth(ctx(['payments.create'])))
    expect(await screen.findByRole('heading', { level: 1, name: 'Cashier' })).toBeInTheDocument()
    expect(screen.getByText('Coming soon')).toBeInTheDocument()
  })

  it('a module without the permission renders 403', async () => {
    renderAt('/r/demo-cafe/cashier', auth(ctx(['orders.create'])))
    expect(await screen.findByRole('heading', { name: 'Not authorised' })).toBeInTheDocument()
    expect(screen.queryByText('Coming soon')).toBeNull()
  })

  it('the generic station board renders a permitted station from its row', async () => {
    renderAt(`/r/demo-cafe/stations/${S_C}`, auth(ctx(['orders.view'], [S_C])))
    expect(await screen.findByRole('heading', { level: 1, name: 'Station Three' })).toBeInTheDocument()
    expect(screen.getByTestId('station-kds')).toHaveAttribute('data-station-id', S_C)
  })

  it('a station outside the user access (or a malformed id) renders 403', async () => {
    renderAt(`/r/demo-cafe/stations/${S_B}`, auth(ctx(['orders.view'], [S_C])))
    expect(await screen.findByRole('heading', { name: 'Not authorised' })).toBeInTheDocument()
  })

  it('a malformed station id renders 403', async () => {
    renderAt('/r/demo-cafe/stations/kitchen', auth(ctx(['orders.view'], [S_C])))
    expect(await screen.findByRole('heading', { name: 'Not authorised' })).toBeInTheDocument()
  })

  it('an accessible but deactivated station shows the unavailable state', async () => {
    h.fetchActiveStations.mockResolvedValue(STATIONS.filter((s) => s.id !== S_A))
    renderAt(`/r/demo-cafe/stations/${S_A}`, auth(ctx(['orders.view'], [S_A])))
    expect(await screen.findByRole('heading', { name: 'Station unavailable' })).toBeInTheDocument()
  })

  it('an unknown path renders the in-shell not-found page', async () => {
    renderAt('/r/demo-cafe/nope', auth(ctx([])))
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
  })

  it('a URL slug of another tenant redirects to the identity tenant home', async () => {
    const router = renderAt('/r/other-cafe/pos', auth(ctx(['orders.create'])))
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe'))
  })
})

describe('active nav state', () => {
  it('Settings is not also current on a settings sub-route', () => {
    renderAt('/r/demo-cafe/settings/terminals', auth(ctx(['settings.manage', 'kiosks.manage'])))
    const current = within(mainNav()).getAllByRole('link', { current: 'page' })
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveAttribute('href', '/r/demo-cafe/settings/terminals')
  })
})

describe('mobile navigation', () => {
  it('opens a drawer with the same generated nav and closes it on navigation', async () => {
    const user = userEvent.setup()
    const router = renderAt('/r/demo-cafe', auth(ctx(['orders.create'])))
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    const dialog = await screen.findByRole('dialog', { name: 'Navigation' })
    await user.click(within(dialog).getByRole('link', { name: 'POS' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/r/demo-cafe/pos'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    renderAt('/r/demo-cafe', auth(ctx([])))
    await user.click(screen.getByRole('button', { name: 'Open navigation' }))
    await screen.findByRole('dialog', { name: 'Navigation' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('home', () => {
  it('shows the tenant from the session context and an empty state without modules', async () => {
    renderAt('/r/demo-cafe', auth(ctx([])))
    expect(await screen.findByRole('heading', { level: 1, name: 'Demo Cafe' })).toBeInTheDocument()
    expect(screen.getByText('Nothing to show yet')).toBeInTheDocument()
  })
})
