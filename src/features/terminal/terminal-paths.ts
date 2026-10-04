import { tenantSlugFromHost } from '@/lib/utils/host'

/** Slug from the browser host (`<slug>.cafeos.et`, `<slug>.localhost`). Pre-auth resolver only; never an authority. */
export function hostTenantSlug(): string | null {
  return tenantSlugFromHost(window.location.host)
}

/** Where the terminal lives for a tenant: `/terminal` on its own subdomain, else the dev/preview fallback path. */
export function terminalPath(slug: string): string {
  return hostTenantSlug() === slug ? '/terminal' : `/r/${slug}/terminal`
}
