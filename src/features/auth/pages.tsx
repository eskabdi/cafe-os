import { useEffect, useRef } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PLATFORM_SUPER_ADMIN, portalOf } from '@/lib/domain/portal'
import { getSessionContext, resolveTenantSlug } from '@/lib/supabase/rpc'
import { fetchTenantLogoUrl } from '@/lib/supabase/tenant-logo'
import { AdminLoginForm } from './AdminLoginForm'
import { StaffLogin } from './StaffLogin'
import { useAuth } from './useAuth'

/** The tenant's current logo (signed 10-minute URL from the public tenant-logo function); nothing when there is none. */
function TenantLogo({ slug }: { slug: string }) {
  const logo = useQuery({ queryKey: ['tenant-logo', slug], queryFn: () => fetchTenantLogoUrl(slug), staleTime: 5 * 60_000, retry: false })
  if (!logo.data) return null
  return <img src={logo.data} alt="" className="mx-auto h-16 w-16 object-contain" referrerPolicy="no-referrer" />
}

function AuthShell({
  title,
  subtitle,
  logoSlug,
  children,
}: {
  title: string
  subtitle?: string
  logoSlug?: string
  children: React.ReactNode
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-6">
      <header className="space-y-1 text-center">
        {logoSlug && <TenantLogo slug={logoSlug} />}
        <p className="text-2xl font-bold text-ink">
          Cafe<span className="text-primary">OS</span>
        </p>
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </header>
      <div className="rounded-card border border-line bg-white p-5 shadow-sm">{children}</div>
    </main>
  )
}

/** If a visitor opens a login page while already signed in (and context loaded), send them on, once. */
function useRedirectIfAlreadySignedIn(target: string | null) {
  const { status, contextStatus } = useAuth()
  const navigate = useNavigate()
  const done = useRef(false)
  useEffect(() => {
    if (done.current || status === 'loading') return
    if (status === 'authenticated' && contextStatus === 'loading') return // wait for the server context
    done.current = true // decided on first known status; later sign-ins navigate via onSignedIn (keeps the MFA step intact)
    if (status === 'authenticated' && contextStatus === 'ready' && target) navigate(target, { replace: true })
  }, [status, contextStatus, target, navigate])
}

function useTenant(slug: string) {
  return useQuery({
    queryKey: ['tenant-slug', slug],
    queryFn: () => resolveTenantSlug(slug),
    staleTime: 60_000,
    retry: false,
  })
}

export function TenantLoginPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const tenant = useTenant(slug)
  useRedirectIfAlreadySignedIn(`/r/${slug}`)

  if (tenant.isPending) {
    return (
      <div role="status" className="p-6 text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }
  if (tenant.isError || !tenant.data) {
    // Unknown, suspended and cancelled slugs are indistinguishable by design.
    return (
      <AuthShell title="Restaurant not found">
        <p className="text-sm text-muted-foreground">Check the address you were given and try again.</p>
      </AuthShell>
    )
  }
  return (
    <AuthShell title={tenant.data.name} subtitle="Staff sign-in" logoSlug={slug}>
      <StaffLogin slug={slug} onSignedIn={() => navigate(`/r/${slug}`, { replace: true })} />
      <p className="mt-4 text-center text-sm">
        <Link className="text-primary underline-offset-4 hover:underline" to={`/r/${slug}/admin-login`}>
          Admin sign-in
        </Link>
      </p>
    </AuthShell>
  )
}

export function TenantAdminLoginPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  useRedirectIfAlreadySignedIn(`/r/${slug}`)
  return (
    <AuthShell title="Admin sign-in" subtitle="Owners and managers use email and password" logoSlug={slug}>
      <AdminLoginForm onSignedIn={() => navigate(`/r/${slug}`, { replace: true })} />
      <p className="mt-4 text-center text-sm">
        <Link className="text-primary underline-offset-4 hover:underline" to={`/r/${slug}/login`}>
          Staff PIN sign-in
        </Link>
      </p>
    </AuthShell>
  )
}

/**
 * The sign-in form only checks WHO this is (an active Super Admin identity, server-derived). The MFA step (verify a code, or
 * set up an authenticator for a new Super Admin) is RequirePlatformAdmin's mfaGate: checking MFA here would sign out an
 * account that has no authenticator yet and lock it out of enrolment.
 */
async function isPlatformIdentity(): Promise<boolean> {
  const ctx = await getSessionContext()
  return ctx?.platform_role === PLATFORM_SUPER_ADMIN
}

export function PlatformLoginPage() {
  const navigate = useNavigate()
  const { context } = useAuth()
  // one account = one portal: a signed-in tenant identity is sent to its own Tenant Portal, never into this one
  const portal = portalOf(context)
  useRedirectIfAlreadySignedIn(
    portal === 'platform' ? '/platform' : portal === 'tenant' && context?.restaurant ? `/r/${context.restaurant.slug}` : null,
  )
  return (
    <AuthShell title="Platform sign-in" subtitle="Platform administrators only">
      <AdminLoginForm
        verify={isPlatformIdentity}
        deniedMessage="This account is not authorised for platform administration."
        onSignedIn={() => navigate('/platform', { replace: true })}
      />
    </AuthShell>
  )
}
