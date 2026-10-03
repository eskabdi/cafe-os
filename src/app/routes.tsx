import { lazy, Suspense } from 'react'
import { createBrowserRouter, Outlet } from 'react-router-dom'
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
    <Suspense fallback={<Loading />}>
      <Outlet />
    </Suspense>
  )
}

// `/r/:slug/*` is only a pre-auth tenant resolver. Tenant identity always comes
// from the authenticated session, never from the slug (CLAUDE.md, multi-tenancy).
// Route guards (auth, RequireRole) arrive in Phase 1.
export const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'r/:slug/*', element: <TenantRoutes /> },
      { path: 'platform/*', element: <PlatformRoutes /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
