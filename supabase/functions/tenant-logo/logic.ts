// Pure logic for the tenant-logo Edge Function (Public endpoint): slug parsing, RPC result validation, response shaping.
// No Deno-only imports and no I/O, so Vitest can import this file. Never logs the slug.

import { isValidSlug } from '../_shared/host.ts'

/** Signed-URL lifetime: long enough to render the sign-in page, short enough that a leaked link soon dies. */
export const LOGO_URL_TTL_SEC = 600

/** ?slug=<tenant slug>; anything else is null (answered exactly like an unknown tenant). */
export function parseSlugParam(url: string): string | null {
  try {
    const u = new URL(url)
    const keys = [...u.searchParams.keys()]
    if (keys.length !== 1 || keys[0] !== 'slug') return null
    const slug = (u.searchParams.get('slug') ?? '').trim().toLowerCase()
    return slug.length <= 63 && isValidSlug(slug) ? slug : null
  } catch {
    return null
  }
}

/** {logo_path} from fn_tenant_logo_for_slug: a path inside restaurants/<uuid>/branding/, else null. */
export function interpretLogoPath(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const p = (data as Record<string, unknown>).logo_path
  if (typeof p !== 'string') return null
  return /^restaurants\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/branding\/[A-Za-z0-9._-]{1,120}$/.test(p) && !p.includes('..')
    ? p
    : null
}

/** The signed URL must point at this project's Storage over https (http only for a local stack). */
export function isSignedUrlForProject(signed: unknown, supabaseUrl: string): signed is string {
  if (typeof signed !== 'string') return false
  try {
    const s = new URL(signed)
    const base = new URL(supabaseUrl)
    if (s.origin !== base.origin || s.username || s.password) return false
    if (s.protocol !== 'https:' && !(s.protocol === 'http:' && ['localhost', '127.0.0.1', 'kong'].includes(s.hostname))) return false
    return s.pathname.startsWith('/storage/v1/object/sign/tenant-branding/')
  } catch {
    return false
  }
}

export interface ShapedResponse {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

/**
 * ONE shape for every outcome a caller could otherwise use as an oracle (unknown slug, no logo, suspended, cancelled, malformed
 * request, signing failure): 200 {url: null}. Only rate limiting and wrong methods differ.
 */
export function shapeLogo(url: string | null): ShapedResponse {
  return {
    status: 200,
    body: { url, expires_in: url ? LOGO_URL_TTL_SEC : null },
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  }
}

export function shapeRateLimited(retryAfterSec: number): ShapedResponse {
  return {
    status: 429,
    body: { error: 'try_later' },
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec))) },
  }
}

export function shapeMethodNotAllowed(): ShapedResponse {
  return {
    status: 405,
    body: { error: 'invalid_request' },
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Allow: 'GET, OPTIONS' },
  }
}
