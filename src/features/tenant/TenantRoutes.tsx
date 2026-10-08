import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/features/auth'
import { tenantHomePath } from '@/features/pin-change/pin-paths'
import { EmptyState, MODULE_NAV, NotFoundState, modulePath } from '@/features/shell'
import { visibleModules } from '@/lib/domain/navigation'

function NoRestaurantAccess() {
  const { signOut } = useAuth()
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

/**
 * Tenant home (`/r/:slug`): an overview of the modules this user may open, generated from the same permission-keyed
 * catalogue as the navigation. Tenant and user come from the server-derived session context, never from the URL.
 */
export default function TenantHome() {
  const { context, can } = useAuth()
  if (!context?.restaurant || !context.user || !context.role) return <NoRestaurantAccess />
  const slug = context.restaurant.slug
  const modules = visibleModules(MODULE_NAV, can)

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{context.restaurant.name}</h1>
        <p className="sr-only" data-testid="tenant-slug">
          {slug}
        </p>
        <p className="text-sm text-muted-foreground">
          {context.user.short_name || context.user.first_name} · {context.role.name}
        </p>
      </div>
      {modules.length === 0 ? (
        <EmptyState title="Nothing to show yet">
          <p>Your role has no modules assigned. Ask your administrator for access.</p>
        </EmptyState>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Modules">
          {modules.map((m) => (
            <li key={m.id}>
              <Link
                to={modulePath(slug, m.segment)}
                className="flex min-h-[44px] items-start gap-3 rounded-card border border-line bg-white p-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                <m.icon aria-hidden="true" className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
                <span>
                  <span className="block font-medium text-ink">{m.label}</span>
                  <span className="block text-sm text-muted-foreground">{m.summary}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Unknown path below `/r/:slug`. */
export function TenantNotFound() {
  const { context } = useAuth()
  if (!context?.restaurant || !context.user || !context.role) return <NoRestaurantAccess />
  return <NotFoundState homePath={tenantHomePath(context.restaurant.slug)} />
}
