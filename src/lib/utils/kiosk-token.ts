import { isValidSlug } from './host'

/**
 * The ONLY place (with ui-prefs.ts and the Supabase client) allowed to touch localStorage: it holds the shared-floor
 * terminal's kiosk token (kiosk-terminals.md). Origin-scoped by the browser, additionally keyed by tenant slug so the
 * localhost / preview fallback (several slugs on one origin) can never send one tenant's token for another.
 * The token is a credential: never logged, never put in a URL, never rendered after its one-time display.
 * Every access is wrapped in try/catch (storage can be blocked); failures read as "no token".
 */
export const KIOSK_TOKEN_PATTERN = /^[0-9a-f]{64}$/

function key(slug: string): string | null {
  return isValidSlug(slug) ? `cafeos:kiosk:${slug}` : null
}

export function getKioskToken(slug: string): string | null {
  const k = key(slug)
  if (!k) return null
  try {
    const v = localStorage.getItem(k)
    return v && KIOSK_TOKEN_PATTERN.test(v) ? v : null
  } catch {
    return null
  }
}

/** Returns false when the token is malformed or storage is unavailable. */
export function setKioskToken(slug: string, token: string): boolean {
  const k = key(slug)
  if (!k || !KIOSK_TOKEN_PATTERN.test(token)) return false
  try {
    localStorage.setItem(k, token)
    return true
  } catch {
    return false
  }
}

export function clearKioskToken(slug: string): void {
  const k = key(slug)
  if (!k) return
  try {
    localStorage.removeItem(k)
  } catch {
    // storage unavailable: nothing to clear
  }
}
