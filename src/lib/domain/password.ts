/**
 * Administrator password policy (Tenant Admin invitation acceptance and the post-reset set-new-password page). UX only:
 * GoTrue's own password rules are the server-side check.
 */
export const MIN_PASSWORD = 12
export const MAX_PASSWORD = 72

/** A fixed, safe message describing the first problem, or null when the password (and its repeat) is acceptable. */
export function passwordProblem(pw: string, confirm: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`
  if (pw.length > MAX_PASSWORD) return `Use at most ${MAX_PASSWORD} characters.`
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return 'Use letters and at least one digit.'
  if (pw !== confirm) return 'The two passwords differ.'
  return null
}
