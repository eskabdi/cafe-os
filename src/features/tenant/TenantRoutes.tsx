import { Navigate, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'

/**
 * Authenticated tenant shell for `/r/:slug/*` (rendered behind RequireAuth). The slug is only a pre-auth
 * resolver: the tenant shown here comes from the server-derived session context, and a mismatching slug
 * is redirected to the identity's own tenant.
 */
export default function TenantRoutes() {
  const { slug } = useParams<{ slug: string }>()
  const { context, signOut } = useAuth()
  const tenantSlug = context?.restaurant?.slug

  if (!context?.restaurant || !context.user || !context.role) {
    // Signed in without a tenant profile (e.g. a platform-only account).
    return (
      <main className="mx-auto max-w-xl space-y-3 p-6">
        <h1 className="text-xl font-semibold text-ink">No restaurant access</h1>
        <p className="text-sm text-muted-foreground">This account is not a member of a restaurant.</p>
        <Button variant="outline" onClick={() => void signOut()}>
          Sign out
        </Button>
      </main>
    )
  }
  if (tenantSlug && slug !== tenantSlug) return <Navigate to={`/r/${tenantSlug}`} replace />

  return (
    <main className="mx-auto max-w-xl space-y-3 p-6">
      <h1 className="text-xl font-semibold text-ink">{context.restaurant.name}</h1>
      <p className="text-muted-foreground" data-testid="tenant-slug">
        {tenantSlug}
      </p>
      <p className="text-sm text-ink">
        {context.user.first_name} · {context.role.name}
      </p>
      <Button variant="outline" onClick={() => void signOut()}>
        Sign out
      </Button>
    </main>
  )
}
