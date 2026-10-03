import { isValidSlug } from './host.ts'

// CORS helpers shared by Edge Functions. Pure (no Deno-only imports) so Vitest can import it.
//
// Policy: an origin is allowed only if it appears verbatim in the ALLOWED_ORIGINS env var
// (comma-separated, e.g. "https://app.cafeos.example,http://localhost:5173"). There is no wildcard:
// a literal "*" entry is ignored. The ONLY wildcard form is a tenant-subdomain one, e.g. "https://*.cafeos.et":
// it matches exactly one label that is a valid, non-reserved slug (so https://platform.cafeos.et is NOT matched). If ALLOWED_ORIGINS is unset or empty, NO cross-origin caller is allowed.

/** Parses the env value into a normalized set of origins. "*" and malformed entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (!entry || entry === '*') continue
    try {
      // restricted wildcard: scheme://*.base[:port] means "exactly one valid, non-reserved tenant label" (see resolveAllowedOrigin);
      // a bare "*" or any other wildcard shape is still ignored
      const wild = /^(https?):\/\/\*\.([a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?)(:\d{1,5})?$/i.exec(entry)
      if (wild) {
        // the base must be a real domain (>= 2 labels, so "https://*.com" is refused); plain http only for localhost dev
        const base = (wild[2] as string).toLowerCase()
        if (base.split('.').length < 2 && base !== 'localhost') continue
        if ((wild[1] as string).toLowerCase() === 'http' && base !== 'localhost' && !base.endsWith('.localhost')) continue
        out.push(`${(wild[1] as string).toLowerCase()}://*.${(wild[2] as string).toLowerCase()}${wild[3] ?? ''}`)
        continue
      }
      const u = new URL(entry)
      if (u.protocol !== 'https:' && u.protocol !== 'http:') continue
      out.push(u.origin)
    } catch {
      // ignore malformed entry
    }
  }
  return out
}

/** Returns the request origin if it is allow-listed, otherwise null. Never returns "*". */
export function resolveAllowedOrigin(origin: string | null | undefined, allowed: readonly string[]): string | null {
  if (!origin) return null
  if (allowed.includes(origin)) return origin
  for (const entry of allowed) {
    if (!entry.includes('*')) continue
    const m = /^(https?):\/\/\*\.(.+?)(:\d{1,5})?$/.exec(entry)
    if (!m) continue
    try {
      const u = new URL(origin)
      const label = u.hostname.endsWith('.' + m[2]) ? u.hostname.slice(0, u.hostname.length - (m[2] as string).length - 1) : null
      const samePort = (u.port ? `:${u.port}` : '') === (m[3] ?? '')
      if (u.protocol === `${m[1]}:` && samePort && label !== null && !label.includes('.') && isValidSlug(label)) return u.origin
    } catch {
      // malformed origin
    }
  }
  return null
}

/** CORS response headers for an allow-listed origin; empty (no CORS grant) otherwise. */
export function corsHeaders(allowedOrigin: string | null): Record<string, string> {
  const base: Record<string, string> = { Vary: 'Origin' }
  if (!allowedOrigin) return base
  return {
    ...base,
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Max-Age': '600',
  }
}
