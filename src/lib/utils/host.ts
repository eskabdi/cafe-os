// MIRROR of supabase/functions/_shared/host.ts for the SPA (the Edge Function tree is Deno-owned, so src/ keeps its own copy).
// src/lib/utils/host.test.ts asserts both implementations agree (reserved list and behaviour). Change both together.
// The slug is only a pre-auth resolver: it never grants access (tenant identity comes from the signed-in profile or a kiosk token).

/** Same format as restaurants_slug_format (migration 0002): 3-40 chars, lowercase alphanumerics and single hyphens inside. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

/**
 * Subdomains that can never be a tenant. The first eleven are the user-specified list; assets, login and r are kept from the
 * original DB list (restaurants_slug_format / fn_slug_is_reserved, migration 0022). Tests on both sides keep the lists equal.
 */
export const RESERVED_SUBDOMAINS = [
  'www',
  'app',
  'api',
  'admin',
  'platform',
  'auth',
  'static',
  'cdn',
  'mail',
  'support',
  'status',
  'assets',
  'login',
  'r',
] as const

/** The reserved host that serves the platform-admin console (platform.cafeos.et). */
export const PLATFORM_SUBDOMAIN = 'platform'

/** Production apex and the local development apex (acme.localhost resolves to 127.0.0.1 in modern browsers). */
export const DEFAULT_BASE_DOMAINS: readonly string[] = ['cafeos.et', 'localhost']

export type HostInfo =
  | { kind: 'tenant'; slug: string }
  | { kind: 'platform' }
  | { kind: 'reserved'; label: string }
  | { kind: 'bare' } // the apex itself (cafeos.et, localhost): marketing / path-based fallback
  | { kind: 'unknown' } // other hosts, IP addresses, nested subdomains, malformed labels

export function isReservedSubdomain(label: string): boolean {
  return (RESERVED_SUBDOMAINS as readonly string[]).includes(label)
}

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('--') && !isReservedSubdomain(slug)
}

/** Lower-cases, strips an optional port and a trailing dot. Accepts a bare host or a full URL/origin. */
export function normalizeHost(hostOrUrl: string | null | undefined): string | null {
  if (typeof hostOrUrl !== 'string') return null
  let h = hostOrUrl.trim().toLowerCase()
  if (!h || h.length > 253) return null
  if (h.includes('://')) {
    try {
      h = new URL(h).host
    } catch {
      return null
    }
  }
  if (h.startsWith('[')) return null // IPv6 literal
  h = h.replace(/:\d{1,5}$/, '').replace(/\.$/, '')
  return h || null
}

/** Classifies a host against the configured base domains. */
export function parseHost(
  hostOrUrl: string | null | undefined,
  baseDomains: readonly string[] = DEFAULT_BASE_DOMAINS,
): HostInfo {
  const host = normalizeHost(hostOrUrl)
  if (!host || /^\d+(\.\d+){3}$/.test(host)) return { kind: 'unknown' }
  for (const base of baseDomains) {
    if (host === base) return { kind: 'bare' }
    if (!host.endsWith('.' + base)) continue
    const label = host.slice(0, host.length - base.length - 1)
    if (label.includes('.')) return { kind: 'unknown' } // exactly one label below the base
    if (label === PLATFORM_SUBDOMAIN) return { kind: 'platform' }
    if (isReservedSubdomain(label)) return { kind: 'reserved', label }
    if (!isValidSlug(label)) return { kind: 'unknown' }
    return { kind: 'tenant', slug: label }
  }
  return { kind: 'unknown' }
}

/** hostname -> tenant slug, or null when the host is not a tenant host. */
export function tenantSlugFromHost(
  hostOrUrl: string | null | undefined,
  baseDomains: readonly string[] = DEFAULT_BASE_DOMAINS,
): string | null {
  const info = parseHost(hostOrUrl, baseDomains)
  return info.kind === 'tenant' ? info.slug : null
}

/**
 * Defence in depth for Edge Functions: when a browser Origin is a TENANT host, its slug must equal the slug the body claims
 * (a page served from acme.cafeos.et cannot ask for another tenant's roster or login). Non-tenant origins (apex, localhost
 * dev, platform) impose no constraint; CORS decides whether they are allowed at all.
 */
export function originSlugMatches(
  origin: string | null | undefined,
  claimedSlug: string,
  baseDomains: readonly string[] = DEFAULT_BASE_DOMAINS,
): boolean {
  if (!origin) return true
  const info = parseHost(origin, baseDomains)
  return info.kind !== 'tenant' || info.slug === claimedSlug
}
