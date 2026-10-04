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
import { TerminalPage, TerminalsPage, terminalPath } from '@/features/terminal'
import { getKioskToken } from '@/lib/utils/kiosk-token'
import { HomePage } from './HomePage'
import { NotFoundPage } from './NotFoundPage'

const TenantRoutes = lazy(() => import('@/features/tenant/TenantRoutes'))
const PlatformRoutes = lazy(() => import('@/features/platform/PlatformRoutes'))

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
              { path: 'settings/terminals', element: <TerminalsPage /> },
              { index: true, element: <TenantRoutes /> },
              { path: '*', element: <TenantRoutes /> },
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
