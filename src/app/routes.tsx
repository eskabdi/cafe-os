import { lazy, Suspense } from 'react'
import { createBrowserRouter, Outlet, useParams, type RouteObject } from 'react-router-dom'
import {
  AuthProvider,
  InactivityGuard,
  PlatformLoginPage,
  RequireAuth,
  RequirePlatformAdmin,
  TenantAdminLoginPage,
  TenantLoginPage,
} from '@/features/auth'
import { NotificationsListener } from '@/features/notifications'
import { ChangePinPage, PinApprovalsPage, PinChangeGate, PinPendingPage } from '@/features/pin-change'
import { SecurityPage, SessionTimersPage } from '@/features/settings'
import { RequireNavPermission, RequireStationAccess, placeholderModuleRoutes } from '@/features/shell'
import { TenantShell } from '@/features/tenant/TenantShell'
import { TerminalPage, TerminalsPage, terminalPath } from '@/features/terminal'
import { getKioskToken } from '@/lib/utils/kiosk-token'
import { HomePage } from './HomePage'
import { NotFoundPage } from './NotFoundPage'

const TenantRoutes = lazy(() => import('@/features/tenant/TenantRoutes'))
const TenantNotFound = lazy(() =>
  import('@/features/tenant/TenantRoutes').then((m) => ({ default: m.TenantNotFound })),
)
const StationKDS = lazy(() =>
  import('@/features/stations/StationKDS').then((m) => ({ default: m.StationKDS })),
)
const PlatformRoutes = lazy(() => import('@/features/platform/PlatformRoutes'))
const MenuPage = lazy(() => import('@/features/menu').then((m) => ({ default: m.MenuPage })))
const InventoryPage = lazy(() => import('@/features/inventory').then((m) => ({ default: m.InventoryPage })))

function Loading() {
  return (
    <div role="status" className="p-6 text-sm text-muted-foreground">
      Loading…
    </div>
  )
}

function Root() {
  return (
    <AuthProvider>
      <InactivityGuard />
      <NotificationsListener />
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </AuthProvider>
  )
}

// Guards are UX only; RLS and RPC checks are the actual authorization (security-controls.md).
function TenantGuard() {
  const { slug = '' } = useParams<{ slug: string }>()
  // A registered terminal returns to its tile screen after sign-out; every other device goes to the normal staff login.
  return <RequireAuth loginPath={getKioskToken(slug) ? terminalPath(slug) : `/r/${slug}/login`} />
}

function PlatformGuard() {
  return (
    <RequireAuth loginPath="/platform/login">
      <RequirePlatformAdmin />
    </RequireAuth>
  )
}

// `/r/:slug/*` is only a pre-auth tenant resolver. Tenant identity always comes
// from the authenticated session, never from the slug (CLAUDE.md, multi-tenancy).
export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { index: true, element: <HomePage /> },
      // Shared floor terminal on a tenant subdomain (<slug>.cafeos.et/terminal). Slug comes from the host.
      { path: 'terminal', element: <TerminalPage /> },
      {
        path: 'r/:slug',
        children: [
          { path: 'login', element: <TenantLoginPage /> },
          { path: 'admin-login', element: <TenantAdminLoginPage /> },
          // dev / preview fallback of the terminal when wildcard DNS is unavailable
          { path: 'terminal', element: <TerminalPage /> },
          {
            element: <TenantGuard />,
            children: [
              {
                // Forced PIN change / maker-checker routing (UX only; the database restricts the account).
                element: <PinChangeGate />,
                children: [
                  {
                    element: <TenantShell />,
                    children: [
                      { path: 'change-pin', element: <ChangePinPage /> },
                      { path: 'pin-pending', element: <PinPendingPage /> },
                      // Route guards use the same permission codes as the nav entries and the server checks (UX only).
                      {
                        path: 'settings/terminals',
                        element: (
                          <RequireNavPermission permission="kiosks.manage">
                            <TerminalsPage />
                          </RequireNavPermission>
                        ),
                      },
                      {
                        path: 'settings/pin-approvals',
                        element: (
                          <RequireNavPermission permission="users.manage">
                            <PinApprovalsPage />
                          </RequireNavPermission>
                        ),
                      },
                      {
                        path: 'settings/session-timers',
                        element: (
                          <RequireNavPermission permission="settings.session_timers">
                            <SessionTimersPage />
                          </RequireNavPermission>
                        ),
                      },
                      { path: 'settings/security', element: <SecurityPage /> },
                      // Phase 3 modules: same permission codes as their nav entries (menu.view / inventory.view).
                      {
                        path: 'menu',
                        element: (
                          <RequireNavPermission permission="menu.view">
                            <MenuPage />
                          </RequireNavPermission>
                        ),
                      },
                      {
                        path: 'inventory',
                        element: (
                          <RequireNavPermission permission="inventory.view">
                            <InventoryPage />
                          </RequireNavPermission>
                        ),
                      },
                      // Generated from the nav catalogue: POS, Cashier, Day close, ... ("coming soon" placeholders).
                      ...placeholderModuleRoutes(),
                      // ONE generic board for every station row (by UUID); never a per-station route.
                      {
                        path: 'stations/:stationId',
                        element: (
                          <RequireStationAccess>
                            <StationKDS />
                          </RequireStationAccess>
                        ),
                      },
                      { index: true, element: <TenantRoutes /> },
                      { path: '*', element: <TenantNotFound /> },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        path: 'platform',
        children: [
          { path: 'login', element: <PlatformLoginPage /> },
          {
            element: <PlatformGuard />,
            children: [
              { index: true, element: <PlatformRoutes /> },
              { path: '*', element: <PlatformRoutes /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]

export const router = createBrowserRouter(routes)
