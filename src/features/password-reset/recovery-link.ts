/**
 * Supabase password-recovery link, implicit flow: GoTrue redirects to RECOVERY_REDIRECT_URL with the session in the URL fragment
 * (`#access_token=…&refresh_token=…&type=recovery…`) or, when the link is expired or already used, with an error
 * (`#error=access_denied&error_code=otp_expired…`, some GoTrue versions put the error in the query string). The client has
 * `detectSessionInUrl: false`, so the page reads the fragment itself, exactly once, and removes it from the address bar.
 *
 * Only `type=recovery` is accepted. The tokens are validated by GoTrue (`setSession` calls /auth/v1/user); the shape checks
 * here only refuse obvious garbage before any network call.
 */
export type RecoveryLink =
  | { kind: 'session'; accessToken: string; refreshToken: string }
  /** GoTrue reported the link as expired / already used / denied. */
  | { kind: 'expired' }
  /** Something is in the URL but it is not a well-formed recovery link (wrong type, missing or malformed tokens). */
  | { kind: 'invalid' }
  /** No link data at all (page opened directly or reloaded after the fragment was removed). */
  | { kind: 'none' }

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const REFRESH_RE = /^[A-Za-z0-9_-]{1,512}$/
const MAX_ACCESS_TOKEN = 8192
const LINK_KEYS = ['access_token', 'refresh_token', 'type', 'error', 'error_code', 'error_description'] as const

export function parseRecoveryLink(hash: string, search: string): RecoveryLink {
  const fragment = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const query = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  if (fragment.has('error') || fragment.has('error_code') || query.has('error') || query.has('error_code')) {
    return { kind: 'expired' }
  }
  const hasAny = LINK_KEYS.some((k) => fragment.has(k))
  if (!hasAny) return { kind: 'none' }
  const accessToken = fragment.get('access_token') ?? ''
  const refreshToken = fragment.get('refresh_token') ?? ''
  if (fragment.get('type') !== 'recovery') return { kind: 'invalid' }
  if (accessToken.length > MAX_ACCESS_TOKEN || !JWT_RE.test(accessToken) || !REFRESH_RE.test(refreshToken)) {
    return { kind: 'invalid' }
  }
  return { kind: 'session', accessToken, refreshToken }
}

/**
 * Reads the link from the current location ONCE and removes it (fragment and query) from the address bar, so no token stays
 * in the browser history or leaks through a later Referer.
 */
export function takeRecoveryLink(loc: Pick<Location, 'hash' | 'search' | 'pathname'> = window.location): RecoveryLink {
  const link = parseRecoveryLink(loc.hash, loc.search)
  if (loc.hash.length > 1 || loc.search.length > 1) window.history.replaceState(null, '', loc.pathname)
  return link
}
