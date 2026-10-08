import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast, type ExternalToast } from 'sonner'
import { useAuth } from '@/features/auth'
import { PIN_APPROVALS_KEY, pinApprovalsPath } from '@/features/pin-change/pin-paths'
import {
  fetchUnreadNotifications,
  subscribeToNotifications,
  type UserNotification,
} from '@/lib/supabase/notifications'
import { markNotificationRead } from '@/lib/supabase/rpc'
import { describeNotification } from './notification-copy'

export const NOTIFICATION_TOAST_MS = 15_000

/**
 * Mounted once under AuthProvider. For a signed-in tenant user: fetches unread notifications on mount and on every Realtime
 * (re)subscription, and listens for INSERTs on the user's own rows (no polling). Each known kind becomes one toast with fixed
 * copy; unknown kinds are ignored (not toasted, not marked read). A toast marks its row read when it is dismissed, closes on its
 * own, or its action is used. On sign-out every toast it showed is removed (shared terminals).
 */
export function NotificationsListener() {
  const { status, context, refreshContext } = useAuth()
  const uid = status === 'authenticated' ? context?.user?.id : undefined
  const navigate = useNavigate()
  const qc = useQueryClient()

  const latest = useRef({ refreshContext, navigate, qc, slug: context?.restaurant?.slug })
  useEffect(() => {
    latest.current = { refreshContext, navigate, qc, slug: context?.restaurant?.slug }
  }, [refreshContext, navigate, qc, context?.restaurant?.slug])

  useEffect(() => {
    if (!uid) return
    let active = true
    const seen = new Set<string>()
    const marked = new Set<string>()

    const markRead = (id: string) => {
      if (!active || marked.has(id)) return
      marked.add(id)
      markNotificationRead(id).catch(() => marked.delete(id))
    }

    const show = (n: UserNotification) => {
      if (!active || seen.has(n.id)) return
      seen.add(n.id)
      const spec = describeNotification(n, uid)
      if (!spec) return
      const { refreshContext: refresh, qc: client } = latest.current
      if (spec.refreshContext) refresh()
      if (spec.invalidateApprovals) void client.invalidateQueries({ queryKey: PIN_APPROVALS_KEY })

      const options: ExternalToast = {
        id: n.id,
        description: spec.description,
        duration: NOTIFICATION_TOAST_MS,
        onDismiss: () => markRead(n.id),
        onAutoClose: () => markRead(n.id),
      }
      if (spec.reviewApprovals) {
        options.action = {
          label: 'Review',
          onClick: () => {
            markRead(n.id)
            const slug = latest.current.slug
            if (slug) latest.current.navigate(pinApprovalsPath(slug))
          },
        }
      }
      if (spec.tone === 'success') toast.success(spec.title, options)
      else if (spec.tone === 'warning') toast.warning(spec.title, options)
      else toast(spec.title, options)
    }

    const loadUnread = () => {
      fetchUnreadNotifications(uid)
        .then((rows) => rows.forEach(show))
        .catch(() => {
          // best effort: the next (re)subscription fetches again
        })
    }

    loadUnread()
    const unsubscribe = subscribeToNotifications(uid, { onInsert: show, onSubscribed: loadUnread })
    return () => {
      active = false
      unsubscribe()
      for (const id of seen) toast.dismiss(id)
    }
  }, [uid])

  return null
}
