// CORS helpers shared by Edge Functions. Pure (no Deno-only imports) so Vitest can import it.
//
// Policy: an origin is allowed only if it appears verbatim in the ALLOWED_ORIGINS env var
// (comma-separated, e.g. "https://app.cafeos.example,http://localhost:5173"). There is no wildcard:
// a literal "*" entry is ignored. If ALLOWED_ORIGINS is unset or empty, NO cross-origin caller is allowed.

/** Parses the env value into a normalized set of origins. "*" and malformed entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (!entry || entry === '*') continue
    try {
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
  return allowed.includes(origin) ? origin : null
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
