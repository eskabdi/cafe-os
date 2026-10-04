import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchUnreadNotifications, subscribeToNotifications, UNREAD_FETCH_LIMIT } from './notifications'

const UID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>,
  result: { data: [] as unknown, error: null as null | { message: string } },
  channel: vi.fn(),
  removeChannel: vi.fn(),
  on: vi.fn(),
  subscribe: vi.fn(),
}))

vi.mock('./client', () => {
  const query: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) {
    query[m] = (...args: unknown[]) => {
      h.calls.push([m, args])
      return query
    }
  }
  query.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.result).then(resolve)
  return {
    supabase: {
      from: (table: string) => {
        h.calls.push(['from', [table]])
        return query
      },
      channel: h.channel,
      removeChannel: h.removeChannel,
    },
  }
})

const row = (over: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  recipient_id: UID,
  kind: 'security.pin_change_approved',
  payload: { profile_id: UID, user_name: 'Abebe K', at: '2026-10-04T08:00:00Z' },
  created_at: '2026-10-04T08:00:00Z',
  read_at: null,
  ...over,
})

beforeEach(() => {
  h.calls = []
  h.result = { data: [], error: null }
  const ch = { on: h.on, subscribe: h.subscribe }
  h.channel.mockReset().mockReturnValue(ch)
  h.on.mockReset().mockReturnValue(ch)
  h.subscribe.mockReset().mockReturnValue(ch)
  h.removeChannel.mockReset().mockResolvedValue('ok')
})

describe('fetchUnreadNotifications', () => {
  it('queries own unread rows, newest first with a limit, and returns them oldest first', async () => {
    const a = row({ id: '44444444-4444-4444-8444-444444444444', created_at: '2026-10-04T09:00:00Z' })
    const b = row()
    h.result = { data: [a, b], error: null }
    const out = await fetchUnreadNotifications(UID)
    expect(out.map((n) => n.id)).toEqual([b.id, a.id])
    expect(h.calls).toEqual([
      ['from', ['user_notifications']],
      ['select', ['id,recipient_id,kind,payload,created_at,read_at']],
      ['eq', ['recipient_id', UID]],
      ['is', ['read_at', null]],
      ['order', ['created_at', { ascending: false }]],
      ['limit', [UNREAD_FETCH_LIMIT]],
    ])
  })

  it('drops malformed, foreign and already-read rows', async () => {
    h.result = {
      data: [row({ id: 'not-a-uuid' }), row({ recipient_id: OTHER }), row({ read_at: '2026-10-04T08:01:00Z' }), row()],
      error: null,
    }
    expect(await fetchUnreadNotifications(UID)).toHaveLength(1)
  })

  it('throws a generic error on failure and refuses a non-uuid user id', async () => {
    h.result = { data: null, error: { message: 'permission denied for table' } }
    await expect(fetchUnreadNotifications(UID)).rejects.toThrow('notifications_unavailable')
    h.calls = []
    expect(await fetchUnreadNotifications('x,recipient_id.neq.x')).toEqual([])
    expect(h.calls).toEqual([])
  })
})

describe('subscribeToNotifications', () => {
  it('subscribes to own INSERTs only and validates each row', () => {
    const onInsert = vi.fn()
    const onSubscribed = vi.fn()
    const unsubscribe = subscribeToNotifications(UID, { onInsert, onSubscribed })
    expect(h.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'user_notifications', filter: `recipient_id=eq.${UID}` },
      expect.any(Function),
    )
    const handler = h.on.mock.calls[0]?.[2] as (c: { new: unknown }) => void
    handler({ new: row() })
    handler({ new: row({ recipient_id: OTHER }) })
    handler({ new: { id: 'x' } })
    expect(onInsert).toHaveBeenCalledTimes(1)

    const status = h.subscribe.mock.calls[0]?.[0] as (s: string) => void
    status('CHANNEL_ERROR')
    expect(onSubscribed).not.toHaveBeenCalled()
    status('SUBSCRIBED')
    expect(onSubscribed).toHaveBeenCalledTimes(1)

    unsubscribe()
    expect(h.removeChannel).toHaveBeenCalledTimes(1)
  })

  it('never builds a filter from a non-uuid id', () => {
    subscribeToNotifications('1,recipient_id=neq.0', { onInsert: vi.fn() })
    expect(h.channel).not.toHaveBeenCalled()
  })
})
