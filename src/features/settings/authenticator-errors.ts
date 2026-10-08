// Neutral copy for the Security page. Supabase Auth error codes are mapped here and never shown; no assurance-level
// vocabulary reaches the user, only "authenticator".

export const AUTHENTICATOR_MESSAGES = {
  code: 'That code did not work. Enter the current 6-digit code from your authenticator app.',
  name: 'Enter a name of 1 to 40 characters.',
  nameTaken: 'That name is already in use. Choose a different one.',
  rateLimited: 'Too many attempts. Please wait a few minutes and try again.',
  generic: 'Something went wrong. Please try again.',
  loadFailed: 'Could not load your authenticators. Please try again.',
} as const

interface AuthLikeError {
  status?: number
  code?: string
}

export function authenticatorErrorMessage(error: unknown): string {
  const e = (typeof error === 'object' && error !== null ? error : {}) as AuthLikeError
  if (e.status === 429 || e.code === 'over_request_rate_limit') return AUTHENTICATOR_MESSAGES.rateLimited
  if (e.code === 'mfa_factor_name_conflict') return AUTHENTICATOR_MESSAGES.nameTaken
  if (
    e.code === 'mfa_verification_failed' ||
    e.code === 'mfa_verification_rejected' ||
    e.code === 'mfa_challenge_expired'
  ) {
    return AUTHENTICATOR_MESSAGES.code
  }
  return AUTHENTICATOR_MESSAGES.generic
}

/** A wrong or stale code is the one failure the user can fix by retyping; show the code message for every verify error that is not rate limiting. */
export function verifyErrorMessage(error: unknown): string {
  const message = authenticatorErrorMessage(error)
  return message === AUTHENTICATOR_MESSAGES.rateLimited ? message : AUTHENTICATOR_MESSAGES.code
}
