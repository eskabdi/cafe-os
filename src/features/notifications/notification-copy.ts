import type { UserNotification } from '@/lib/supabase/notifications'

// Fixed, safe copy per notification kind. Payload values are only ever interpolated into plain strings that React renders as
// text (never HTML), after being trimmed, stripped of control characters and length-capped. Unknown kinds return null.

export const NOTIFICATION_KIND = {
  concurrentLoginBlocked: 'security.concurrent_login_blocked',
  pinChangePending: 'security.pin_change_pending_approval',
  pinChangeApproved: 'security.pin_change_approved',
  pinChangeRejected: 'security.pin_change_rejected',
} as const

export type ToastTone = 'info' | 'success' | 'warning'

export interface NotificationToast {
  title: string
  description?: string
  tone: ToastTone
  /** Offer a link to the PIN approvals page. */
  reviewApprovals: boolean
  /** The recipient's own PIN-change state changed: reload the session context. */
  refreshContext: boolean
  /** The pending-approvals list changed. */
  invalidateApprovals: boolean
}

const MAX_TEXT = 60
const FALLBACK_NAME = 'A staff member'

/** Plain text for display: strings only, control characters removed, whitespace collapsed, capped. */
export function safeText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
  const text = cleaned.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

const base = { reviewApprovals: false, refreshContext: false, invalidateApprovals: false }

/** `selfId` is the signed-in user's id: a notification ABOUT the recipient gets first-person copy, otherwise the admin copy. */
export function describeNotification(n: UserNotification, selfId: string): NotificationToast | null {
  const subjectId = typeof n.payload.profile_id === 'string' ? n.payload.profile_id : null
  const aboutSelf = subjectId !== null && subjectId === selfId
  const name = safeText(n.payload.user_name) ?? FALLBACK_NAME

  switch (n.kind) {
    case NOTIFICATION_KIND.concurrentLoginBlocked: {
      if (aboutSelf) {
        return {
          ...base,
          tone: 'warning',
          title: 'Your PIN was used on another device',
          description: 'That sign-in was blocked. Choose a new PIN to continue.',
          refreshContext: true,
        }
      }
      const kiosk = safeText(n.payload.kiosk_name)
      return {
        ...base,
        tone: 'warning',
        title: `${name} was blocked from signing in on a second device`,
        description: kiosk ? `Terminal: ${kiosk}` : undefined,
      }
    }
    case NOTIFICATION_KIND.pinChangePending:
      if (aboutSelf) return null
      return {
        ...base,
        tone: 'info',
        title: `${name} changed their PIN and is waiting for your approval`,
        reviewApprovals: true,
        invalidateApprovals: true,
      }
    case NOTIFICATION_KIND.pinChangeApproved:
      if (!aboutSelf) return null
      return {
        ...base,
        tone: 'success',
        title: 'Your new PIN was approved',
        description: 'You can continue working.',
        refreshContext: true,
      }
    case NOTIFICATION_KIND.pinChangeRejected:
      if (!aboutSelf) return null
      return {
        ...base,
        tone: 'warning',
        title: 'Your new PIN was not approved',
        description: 'Please choose a different PIN.',
        refreshContext: true,
      }
    default:
      return null
  }
}
