// Pure helpers (no Supabase client import) so UI code and tests can use them without configuration.

export type PinLoginFailure = 'invalid_credentials' | 'rate_limited' | 'invalid_request' | 'network' | 'server_error'

export function failureFromStatus(status: number): PinLoginFailure {
  if (status === 401) return 'invalid_credentials'
  if (status === 429) return 'rate_limited'
  if (status === 400 || status === 413) return 'invalid_request'
  return 'server_error'
}

/** Safe, non-enumerating user messages. Lockout, unknown user, admin and wrong PIN share one message. */
export const PIN_LOGIN_MESSAGES: Record<PinLoginFailure, string> = {
  invalid_credentials: 'Could not sign in. Check your username and PIN, or sign out of any other device first. If it keeps happening, ask your manager.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  invalid_request: 'Enter your username and your PIN (4-digit PIN, 6 digits for Cashier).',
  network: 'Cannot reach the server. Check your connection and try again.',
  server_error: 'Something went wrong. Please try again.',
}

// Client-side mirror of the Edge Function's input rules (UX only; the server re-validates).
// Kept in sync with supabase/functions/pin-login/logic.ts; a unit test checks parity.
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/
export const PIN_PATTERN = /^[0-9]{4}$|^[0-9]{6}$/
export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 6
