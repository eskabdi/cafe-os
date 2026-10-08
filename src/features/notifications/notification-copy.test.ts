import { describe, expect, it } from 'vitest'
import type { UserNotification } from '@/lib/supabase/notifications'
import { describeNotification, safeText } from './notification-copy'

const ME = '11111111-1111-4111-8111-111111111111'
const n = (kind: string, payload: Record<string, unknown>): UserNotification => ({
  id: '33333333-3333-4333-8333-333333333333',
  recipient_id: ME,
  kind,
  payload,
  created_at: '2026-10-04T08:00:00Z',
  read_at: null,
})

describe('safeText', () => {
  it('keeps strings only, strips control / bidi characters, collapses whitespace and caps length', () => {
    expect(safeText(42)).toBeNull()
    expect(safeText('   ')).toBeNull()
    expect(safeText('A\u0000b‮c\n\td')).toBe('A b c d')
    const long = 'x'.repeat(100)
    const out = safeText(long)
    expect(out).toHaveLength(60)
    expect(out?.endsWith('…')).toBe(true)
  })
})

describe('describeNotification', () => {
  it('returns null for unknown kinds', () => {
    expect(describeNotification(n('security.something_new', { user_name: 'x' }), ME)).toBeNull()
    expect(describeNotification(n('', {}), ME)).toBeNull()
  })

  it('gives first-person copy only about the recipient and admin copy otherwise', () => {
    const blockedSelf = describeNotification(n('security.concurrent_login_blocked', { profile_id: ME }), ME)
    expect(blockedSelf).toMatchObject({ refreshContext: true, tone: 'warning' })
    const blockedOther = describeNotification(
      n('security.concurrent_login_blocked', { profile_id: 'other', user_name: 'Sara' }),
      ME,
    )
    expect(blockedOther).toMatchObject({
      title: 'Sara was blocked from signing in on a second device',
      refreshContext: false,
    })
    expect(
      describeNotification(
        n('security.pin_change_pending_approval', { profile_id: 'other', user_name: 'Sara' }),
        ME,
      ),
    ).toMatchObject({ reviewApprovals: true, invalidateApprovals: true })
    expect(describeNotification(n('security.pin_change_approved', { profile_id: 'other' }), ME)).toBeNull()
    expect(describeNotification(n('security.pin_change_rejected', { profile_id: ME }), ME)).toMatchObject({
      refreshContext: true,
    })
  })
})
