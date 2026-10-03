import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from './useAuth'

// IMPORTANT: these guards are UX only. They decide what to render, never what is allowed. Every query and
// command is re-authorized on the server (RLS + security-definer RPC checks), so a bypassed guard exposes nothing.

function Loading() {
  return (
    <div role="status" className="p-6 text-sm text-muted-foreground">
      Loading…
    </div>
  )
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="mx-auto max-w-md space-y-3 p-6">
      <h1 className="text-xl font-semibold text-ink">{title}</h1>
      <div role="alert" className="space-y-3 text-sm text-muted-foreground">
        {children}
      </div>
    </main>
  )
}

export interface RequireAuthProps {
  loginPath: string
  children?: ReactNode
}

/** Renders children (or an <Outlet/>) only for a signed-in user whose server-side context loaded. */
export function RequireAuth({ loginPath, children }: RequireAuthProps) {
  const { status, contextStatus, context, signOut, refreshContext } = useAuth()
  const location = useLocation()

  if (status === 'loading' || (status === 'authenticated' && contextStatus === 'loading')) return <Loading />
  if (status === 'signed_out') return <Navigate to={loginPath} replace state={{ from: location.pathname }} />
  if (contextStatus === 'error') {
    return (
      <Notice title="Could not load your account">
        <p>Please check your connection and try again.</p>
        <div className="flex gap-2">
          <Button onClick={refreshContext}>Retry</Button>
          <Button variant="outline" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </Notice>
    )
  }
  if (!context) {
    // No active profile, deactivated user, or suspended/cancelled tenant: the server returned no context.
    return (
      <Notice title="Access unavailable">
        <p>Your account has no access right now. Contact your administrator.</p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Notice>
    )
  }
  return <>{children ?? <Outlet />}</>
}

export interface RequirePermissionProps {
  permission: string
  children?: ReactNode
  fallback?: ReactNode
}

/** Renders children only if the server-derived permission list contains `permission`. UX only. */
export function RequirePermission({ permission, children, fallback }: RequirePermissionProps) {
  const { can } = useAuth()
  if (!can(permission)) {
    return (
      <>{fallback ?? <Notice title="Not authorised">You do not have permission to view this page.</Notice>}</>
    )
  }
  return <>{children ?? <Outlet />}</>
}

/** Platform surface guard: requires the server-reported platform role. UX only; platform tables are RLS-protected. */
export function RequirePlatformAdmin({ children }: { children?: ReactNode }) {
  const { context } = useAuth()
  if (context?.platform_role !== 'platform_super_admin') {
    return <Notice title="Not authorised">This area is for platform administrators.</Notice>
  }
  return <>{children ?? <Outlet />}</>
}
