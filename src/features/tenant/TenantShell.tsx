import { Navigate, Outlet, useParams } from 'react-router-dom'
import { useAuth } from '@/features/auth'
import { tenantHomePath } from '@/features/pin-change/pin-paths'
import { AppShell } from '@/features/shell'
import { TenantThemeProvider } from './TenantThemeProvider'

/**
 * Layout for every signed-in tenant route (behind RequireAuth + PinChangeGate): tenant theme + responsive shell with the
 * permission-generated navigation. The slug is only a pre-auth resolver: the tenant shown comes from the server-derived
 * session context, and a URL slug that does not match the identity's tenant is redirected to the home of its own tenant.
 */
export function TenantShell() {
  const { context } = useAuth()
  const { slug: urlSlug } = useParams<{ slug: string }>()
  const slug = context?.restaurant?.slug
  if (!slug || !context?.user) return <Outlet />
  if (urlSlug !== slug) return <Navigate to={tenantHomePath(slug)} replace />
  return (
    <TenantThemeProvider branding={context.restaurant?.branding}>
      <AppShell slug={slug} />
    </TenantThemeProvider>
  )
}
