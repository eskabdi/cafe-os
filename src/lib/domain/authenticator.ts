import { z } from 'zod'

// Authenticator-app (TOTP) enrollment helpers. Pure and UX-only: Supabase Auth issues and verifies factors, and the
// database re-checks the assurance level (fn_require_aal2) on every protected command.

/** Domain suffix of the synthetic, non-routable emails behind PIN logins (supabase/functions/pin-login/logic.ts). */
const PIN_ACCOUNT_EMAIL_SUFFIX = '.staff.cafeos.invalid'

/**
 * True when the signed-in identity came from standard Supabase Auth (email + password) rather than a PIN login.
 * PIN accounts are created by the staff-create Edge Function with `app_metadata.staff = true` (service role only, not
 * user-writable) and a synthetic email; either marker means "PIN account". No role names are consulted. UX only: it
 * decides whether to offer the Security page, never what the server allows.
 */
export function usesSupabaseAuthSignIn(
  session:
    { user: { email?: string | null; app_metadata?: Record<string, unknown> | null } } | null | undefined,
): boolean {
  if (!session) return false
  if (session.user.app_metadata?.staff === true) return false
  const email = session.user.email
  if (typeof email === 'string' && email.toLowerCase().endsWith(PIN_ACCOUNT_EMAIL_SUFFIX)) return false
  return true
}

export const totpCodeSchema = z.string().regex(/^[0-9]{6}$/)

export const authenticatorNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  .regex(/^[^\u0000-\u001f\u007f‪-‮⁦-⁩]+$/)

export const DEFAULT_AUTHENTICATOR_NAME = 'Authenticator app'

const SVG_DATA_PREFIX = /^data:image\/svg\+xml(?:;[a-z0-9=-]+)*,/i
const MAX_QR_LENGTH = 20_000

/**
 * Turns the QR value returned by auth.mfa.enroll (raw `<svg ...>` markup, or already a `data:image/svg+xml,` URL) into an
 * image source for a plain <img>. Browsers never run scripts inside an SVG loaded through <img>, and the existing CSP
 * already allows `img-src data:`, so nothing is injected into the DOM as markup. Anything that is not an SVG document
 * returns null and the caller falls back to the manual setup key.
 */
export function qrImageSrc(qr: unknown): string | null {
  if (typeof qr !== 'string' || qr.length === 0 || qr.length > MAX_QR_LENGTH) return null
  let svg = qr
  const prefix = SVG_DATA_PREFIX.exec(qr)
  if (prefix) {
    svg = qr.slice(prefix[0].length)
    try {
      svg = decodeURIComponent(svg)
    } catch {
      // the payload was raw markup containing a literal percent sign
    }
  }
  if (!/^\s*<svg[\s>]/i.test(svg)) return null
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Groups a base32 setup key in blocks of four for reading aloud / typing. Display only; copy uses the raw key. */
export function formatSetupKey(secret: string): string {
  return secret
    .replace(/\s+/g, '')
    .replace(/(.{4})/g, '$1 ')
    .trim()
}
