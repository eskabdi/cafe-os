// PIN policy + peppered digest. Pure (Web Crypto only, no Deno-only imports) so Vitest can import it.
//
// The database never sees a raw PIN: Edge Functions send digest = hex(HMAC-SHA256(pin, PIN_PEPPER)) to
// fn_verify_pin / fn_set_user_pin, which bcrypt it. PIN_PEPPER lives only in the Edge Function environment, so a
// leaked database cannot be brute-forced offline (a 4-digit PIN has only 10^4 candidates; the lockout is what limits online guessing). The weak-PIN policy is
// enforced HERE because only here is the raw PIN visible. Never log a PIN, a digest or the pepper.

export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 4
export const PIN_RE = /^[0-9]{4}$/
export const MIN_PEPPER_LENGTH = 32
/** The pepper seed.sql uses for the demo PINs. Valid only where the seed guard passed (local stack / CI). */
export const DEMO_PEPPER = 'cafeos-local-demo-pepper-do-not-use-v1'

const COMMON_WEAK = new Set(['1122', '2211', '1212', '2580', '0852', '1004', '2000', '1357', '2468', '1379', '1313', '6969', '1998', '2001'])

/** True for PINs that must not be accepted when SETTING a PIN. */
export function isWeakPin(pin: string): boolean {
  if (!PIN_RE.test(pin)) return true
  if (COMMON_WEAK.has(pin)) return true
  const d = [...pin].map((c) => c.charCodeAt(0) - 48)
  // constant step modulo 10: 111111, 123456, 654321, 135791, 246802, 789012 ...
  const step = (((d[1] ?? 0) - (d[0] ?? 0)) % 10 + 10) % 10
  if (d.every((v, i) => i === 0 || (((v - (d[i - 1] ?? 0)) % 10) + 10) % 10 === step)) return true
  // repeated blocks of 1-3 digits: 121212, 123123, 12121212, 1231231
  for (const k of [1, 2, 3]) {
    if (k < pin.length && pin === pin.slice(0, k).repeat(Math.ceil(pin.length / k)).slice(0, pin.length)) return true
  }
  return false
}

export function isUsablePepper(pepper: string | undefined | null): pepper is string {
  return typeof pepper === 'string' && pepper.length >= MIN_PEPPER_LENGTH
}

const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** hex(HMAC-SHA256(key = pepper, message = pin)), 64 lowercase hex characters (what the SQL functions accept). */
export async function computePinDigest(pin: string, pepper: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(pin)))
}
