import type { PinLoginFailure } from './pin-login-errors'

/**
 * Copy for the shared floor terminal (tile path). Deliberately separate from PIN_LOGIN_MESSAGES: no username wording and no
 * PIN-length hints. invalid_credentials stays ONE generic message (lockout, wrong PIN, other session, ineligible tile).
 */
export const TILE_LOGIN_MESSAGES: Record<PinLoginFailure, string> = {
  invalid_credentials: 'Could not sign in. Please try again, or ask your manager for help.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  invalid_request: 'Could not sign in. Please try again.',
  network: 'Cannot reach the server. Check the connection and try again.',
  server_error: 'Something went wrong. Please try again.',
}
