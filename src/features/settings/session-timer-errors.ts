import { SESSION_TIMER_FIELDS, type SessionTimerField } from '@/lib/domain/session-timers'

/** Neutral copy for fn_get/update/reset_session_timers failures (machine codes only; mfa_required opens the step-up instead). */
export function sessionTimersErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'mfa_required':
      return 'Verify with your authenticator to continue.'
    case 'permission_denied':
      return 'You do not have permission to change these settings.'
    case 'tenant_read_only':
    case 'tenant_suspended':
      return 'This restaurant account cannot make changes right now.'
    case 'invalid_input':
      return 'Some values are not allowed. Check the fields and try again.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

const FIELD_MESSAGES: Record<SessionTimerField, string> = {
  idle_warning_seconds: 'The warning must come after at least 5 seconds and before the sign-out time.',
  signout_seconds: 'Sign-out must be between 15 and 900 seconds.',
  pin_pad_idle_seconds: 'The PIN pad time must be between 15 and 300 seconds.',
}

/** The field named by an invalid_input detail, or null if the detail is not one of the three known fields. */
export function invalidField(detail: string | undefined): SessionTimerField | null {
  return SESSION_TIMER_FIELDS.find((f) => f === detail) ?? null
}

export function fieldErrorMessage(field: SessionTimerField): string {
  return FIELD_MESSAGES[field]
}
