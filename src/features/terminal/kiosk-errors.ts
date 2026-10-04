/** Neutral, safe copy for kiosk-admin RPC failures (machine codes from rpc-conventions; nothing else is surfaced). */
export function kioskErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'mfa_required':
      return 'Please confirm it is you with your second sign-in step, then try again.'
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
