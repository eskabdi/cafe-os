/**
 * Fixed notices a sign-in page can show after a redirect. The navigation state carries only the KEY; the text is fixed here, so
 * nothing from the URL or from tenant data is ever rendered as a notice.
 */
export const LOGIN_NOTICES = {
  password_changed: 'Password changed. Sign in, then set up your authenticator again.',
  password_changed_signout_unconfirmed:
    'Password changed. Signing out your other devices could not be confirmed; their old sessions are blocked from every authenticator-protected action. Sign in, then set up your authenticator again.',
} as const

export type LoginNoticeKey = keyof typeof LOGIN_NOTICES

export function loginNoticeFromState(state: unknown): string | null {
  if (!state || typeof state !== 'object' || !('notice' in state)) return null
  const key = (state as { notice: unknown }).notice
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(LOGIN_NOTICES, key)
    ? LOGIN_NOTICES[key as LoginNoticeKey]
    : null
}
