import { z } from 'zod'
import { supabase } from './client'

// Own in-app notifications (table user_notifications, migration 0023). RLS limits SELECT to the recipient's own rows in the
// caller's tenant; there are no client write grants (mark read goes through fn_mark_notification_read in rpc.ts).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const notificationSchema = z.object({
  id: z.string().regex(UUID_RE),
  recipient_id: z.string().regex(UUID_RE),
  kind: z.string().max(64),
  payload: z.record(z.unknown()).default({}),
  created_at: z.string(),
  read_at: z.string().nullable().optional(),
})
export type UserNotification = z.infer<typeof notificationSchema>

/** How many unread notifications are fetched on mount (newest first, shown oldest first). */
export const UNREAD_FETCH_LIMIT = 10
const COLUMNS = 'id,recipient_id,kind,payload,created_at,read_at'

type Result = { data: unknown; error: { message: string } | null }
interface NotificationQuery extends PromiseLike<Result> {
  select(columns: string): NotificationQuery
  eq(column: string, value: string): NotificationQuery
  is(column: string, value: null): NotificationQuery
  order(column: string, options: { ascending: boolean }): NotificationQuery
  limit(n: number): NotificationQuery
}

function parseRows(data: unknown, uid: string): UserNotification[] {
  if (!Array.isArray(data)) return []
  const out: UserNotification[] = []
  for (const row of data) {
    const parsed = notificationSchema.safeParse(row)
    if (parsed.success && parsed.data.recipient_id === uid && !parsed.data.read_at) out.push(parsed.data)
  }
  return out
}

/** Unread notifications of `uid`, oldest first. Rows that fail validation are dropped, never rendered. */
export async function fetchUnreadNotifications(uid: string): Promise<UserNotification[]> {
  if (!UUID_RE.test(uid)) return []
  const client = supabase as unknown as { from: (table: string) => NotificationQuery }
  const { data, error } = await client
    .from('user_notifications')
    .select(COLUMNS)
    .eq('recipient_id', uid)
    .is('read_at', null)
    .order('created_at', { ascending: false })
    .limit(UNREAD_FETCH_LIMIT)
  if (error) throw new Error('notifications_unavailable')
  return parseRows(data, uid).reverse()
}

export interface NotificationSubscription {
  onInsert: (n: UserNotification) => void
  /** Called on every (re)subscription so the caller can re-fetch anything missed while disconnected. */
  onSubscribed?: () => void
}

/**
 * Realtime INSERTs on the caller's own notifications (filter recipient_id=eq.<uid>; RLS is applied by Realtime as well).
 * Returns an unsubscribe function. No polling.
 */
export function subscribeToNotifications(uid: string, handlers: NotificationSubscription): () => void {
  if (!UUID_RE.test(uid)) return () => {}
  const channel = supabase
    .channel(`user-notifications:${uid}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `recipient_id=eq.${uid}` },
      (change: { new: unknown }) => {
        const parsed = notificationSchema.safeParse(change.new)
        if (parsed.success && parsed.data.recipient_id === uid && !parsed.data.read_at) handlers.onInsert(parsed.data)
      },
    )
    .subscribe((status: string) => {
      if (status === 'SUBSCRIBED') handlers.onSubscribed?.()
    })
  return () => {
    void supabase.removeChannel(channel)
  }
}
