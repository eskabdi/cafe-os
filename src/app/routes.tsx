import { lazy, Suspense } from 'react'
import { createBrowserRouter, Outlet, useParams } from 'react-router-dom'
import {
  AuthProvider,
  PlatformLoginPage,
  RequireAuth,
  RequirePlatformAdmin,
  TenantAdminLoginPage,
  TenantLoginPage,
} from '@/features/auth'
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
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
    </AuthProvider>
  )
}

// Guards are UX only; RLS and RPC checks are the actual authorization (security-controls.md).
function TenantGuard() {
  const { slug = '' } = useParams<{ slug: string }>()
  return <RequireAuth loginPath={`/r/${slug}/login`} />
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
export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'r/:slug',
        children: [
          { path: 'login', element: <TenantLoginPage /> },
          { path: 'admin-login', element: <TenantAdminLoginPage /> },
          {
            element: <TenantGuard />,
            children: [
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
])
