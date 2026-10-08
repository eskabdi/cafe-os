/** Neutral copy for fn_approve_pin_change / fn_reject_pin_change / fn_list_pending_pin_changes failures (machine codes only). */
export function pinApprovalErrorMessage(code: string | undefined): string {
  switch (code) {
    case 'mfa_required':
      return 'Verify with your authenticator to continue.'
    case 'not_found':
      return 'This request is no longer waiting for approval. The list has been updated.'
    case 'permission_denied':
    case 'permission_escalation':
      return 'You do not have permission to decide on this request.'
    case 'invalid_input':
      return 'This request could not be processed. Refresh the list and try again.'
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'This restaurant account cannot make changes right now.'
    default:
      return 'Something went wrong. Please try again.'
  }
}
