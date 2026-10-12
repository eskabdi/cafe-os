/**
 * Administrator password policy (Tenant Admin invitation acceptance and the post-reset set-new-password page). UX only: GoTrue's
 * own rules are the server-side check. Mirrors supabase/config.toml [auth]: minimum_password_length = 12 and
 * password_requirements = "lower_upper_letters_digits_symbols" (at least one lowercase letter, one uppercase letter, one digit and
 * one symbol from GoTrue's symbol set), plus bcrypt's 72-byte limit.
 */
export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 72
/** GoTrue's symbol set for lower_upper_letters_digits_symbols. */
export const PASSWORD_SYMBOLS = '!@#$%^&*()_+-=[]{};\'\\:"|<>?,./`~'
/** The policy in one line, for form hints. */
export const PASSWORD_HINT = `${MIN_PASSWORD} to ${MAX_PASSWORD} characters with a lowercase letter, an uppercase letter, a digit and a symbol (for example ! # $ %).`

const hasSymbol = (pw: string) => [...pw].some((c) => PASSWORD_SYMBOLS.includes(c))

/** A fixed, safe message describing the first problem, or null when the password (and its repeat) is acceptable. */
export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (pw.length > MAX_PASSWORD || new TextEncoder().encode(pw).byteLength > MAX_PASSWORD)
    return `Use at most ${MAX_PASSWORD} characters (fewer when they are not plain Latin letters).`
  if (!/[a-z]/.test(pw)) return 'Add a lowercase letter.'
  if (!/[A-Z]/.test(pw)) return 'Add an uppercase letter.'
  if (!/[0-9]/.test(pw)) return 'Add a digit.'
  if (!hasSymbol(pw)) return 'Add a symbol, for example ! # $ % or -.'
  if (pw !== confirm) return 'The two passwords differ.'
  return null
}
