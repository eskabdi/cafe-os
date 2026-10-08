// Pure helpers for the pin-change Edge Function (no Supabase client import), shared by the typed client and the UI.
// Contract: supabase/functions/pin-change/README.md.

export type PinChangeFailure =
  | 'invalid_credentials'
  | 'unauthorized'
  | 'weak_pin'
  | 'same_pin'
  | 'invalid_pin_length'
  | 'invalid_request'
  | 'rate_limited'
  | 'network'
  | 'server_error'

/** Fallback wait when a 429 has no usable Retry-After header. */
export const DEFAULT_RETRY_AFTER_SEC = 30
/** Upper bound so a hostile or broken header cannot lock the form for hours. */
export const MAX_RETRY_AFTER_SEC = 15 * 60

const BAD_REQUEST_CODES = new Set<PinChangeFailure>(['weak_pin', 'same_pin', 'invalid_pin_length', 'invalid_request'])

/**
 * Maps an HTTP status plus the whitelisted `error` code of the body to one failure kind. Unknown codes never pass through:
 * a 401 is invalid_credentials unless the body says exactly `unauthorized`, and a 400 with an unknown code is invalid_request.
 */
export function pinChangeFailureFrom(status: number, code: unknown): PinChangeFailure {
  if (status === 401) return code === 'unauthorized' ? 'unauthorized' : 'invalid_credentials'
  if (status === 429) return 'rate_limited'
  if (status === 400) {
    return typeof code === 'string' && BAD_REQUEST_CODES.has(code as PinChangeFailure)
      ? (code as PinChangeFailure)
      : 'invalid_request'
  }
  if (status === 413) return 'invalid_request'
  return 'server_error'
}

/** Retry-After as delta-seconds (the function never sends an HTTP date). Clamped to [1, MAX_RETRY_AFTER_SEC]. */
export function parseRetryAfter(header: string | null | undefined): number {
  if (!header || !/^\s*\d{1,6}\s*$/.test(header)) return DEFAULT_RETRY_AFTER_SEC
  return Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Number.parseInt(header, 10)))
}

/**
 * Neutral user copy. A wrong current PIN, a locked account and an ineligible account share one message, and no message ever
 * mentions attempts left or a lock (the server never reveals those either).
 */
export function pinChangeMessage(reason: PinChangeFailure, pinLength: number, retryAfterSec?: number): string {
  switch (reason) {
    case 'invalid_credentials':
      return 'Your current PIN was not accepted. Check it and try again. If it keeps happening, ask your manager.'
    case 'unauthorized':
      return 'Your session has ended. Please sign in again.'
    case 'weak_pin':
      return 'That PIN is too easy to guess. Avoid repeated or sequential digits and choose another.'
    case 'same_pin':
      return 'Your new PIN must be different from your current PIN.'
    case 'invalid_pin_length':
      return `Your PIN must be exactly ${pinLength} digits.`
    case 'invalid_request':
      return `Enter your current PIN and a new ${pinLength}-digit PIN.`
    case 'rate_limited':
      return `Too many attempts. Try again in ${retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC} seconds.`
    case 'network':
      return 'Cannot reach the server. Check your connection and try again.'
    case 'server_error':
      return 'Something went wrong. Please try again.'
  }
}
