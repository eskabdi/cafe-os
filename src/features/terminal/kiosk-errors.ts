/**
 * Neutral, safe copy for kiosk-admin RPC failures (machine codes from rpc-conventions; nothing else is surfaced).
 * `mfa_required` normally opens the step-up dialog instead; its copy is what the admin sees if they cancel it or the
 * retried request is refused again (same wording as the other step-up pages, no assurance-level vocabulary).
 */
export function kioskErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'mfa_required':
      return 'Verify with your authenticator to continue.'
    case 'permission_denied':
      return 'You do not have permission to do that.'
    case 'kiosk_limit_reached':
      return 'The limit of active terminals is reached. Revoke one you no longer use first.'
    case 'invalid_input':
      return 'Enter a name for the terminal (up to 60 characters).'
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'This restaurant account cannot make changes right now.'
    default:
      return 'Something went wrong. Please try again.'
  }
}
