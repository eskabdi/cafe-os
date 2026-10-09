import type { ReactNode } from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { isPlatformSuperAdmin, platformMfaSatisfied, portalOf } from '@/lib/domain/portal'
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

/**
 * Platform Admin Portal guard (§34A). A tenant identity is sent to its own Tenant Portal; any other non-platform account
 * sees a clear "not a platform account" page; a Super Admin whose session is not yet aal2 with a live factor sees `mfaGate`
 * (verify or set up an authenticator). UX only: every platform RPC re-checks all of it (fn_platform_guard).
 */
export function RequirePlatformAdmin({ children, mfaGate }: { children?: ReactNode; mfaGate?: ReactNode }) {
  const { context, session, signOut } = useAuth()
  if (portalOf(context) === 'tenant' && context?.restaurant?.slug) {
    return <Navigate to={`/r/${context.restaurant.slug}`} replace />
  }
  if (!isPlatformSuperAdmin(context)) {
    return (
      <Notice title="Not a platform account">
        <p>This area is for CafeOS platform administrators only. Restaurant accounts use their restaurant’s address.</p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Notice>
    )
  }
  if (mfaGate && !platformMfaSatisfied(context, session?.access_token)) return <>{mfaGate}</>
  return <>{children ?? <Outlet />}</>
}

/**
 * Tenant Portal guard (§34A): a platform admin never renders a tenant screen (redirected to /platform); an account without a
 * tenant profile sees a neutral notice. UX only: tenant RLS and RPCs answer permission_denied / zero rows to platform admins.
 */
export function RequireTenantIdentity({ children }: { children?: ReactNode }) {
  const { context, signOut } = useAuth()
  const portal = portalOf(context)
  if (portal === 'platform') return <Navigate to="/platform" replace />
  if (portal !== 'tenant') {
    return (
      <Notice title="Not a restaurant account">
        <p>This account has no access to a restaurant. Contact your administrator.</p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </Notice>
    )
  }
  return <>{children ?? <Outlet />}</>
}
