import { describe, expect, it } from 'vitest'
import { readLimitedBody } from '../../supabase/functions/_shared/body'
import {
  MAX_BODY_BYTES,
  interpretPrepare,
  interpretResend,
  interpretRevoke,
  isDeletableInvitee,
  isSafeRedirect,
  mapRpcError,
  parseInviteBody,
  shapeFailure,
  shapeSuccess,
} from '../../supabase/functions/tenant-admin-invite/logic'

const RID = '11111111-1111-4111-8111-111111111111'
const INV = '22222222-2222-4222-8222-222222222222'
const USER = '33333333-3333-4333-8333-333333333333'
const body = (o: unknown) => JSON.stringify(o)
const invite = {
  action: 'invite',
  email: 'New.Owner@Fresh.Example.com ',
  first_name: ' Almaz ',
  username: 'Almaz',
}

describe('parseInviteBody', () => {
  it('accepts an invite and normalises e-mail / username / names', () => {
    const r = parseInviteBody(body({ ...invite, restaurant_id: RID, middle_name: 'Kebede' }))
    expect(r).toEqual({
      ok: true,
      value: {
        action: 'invite',
        restaurant_id: RID,
        email: 'new.owner@fresh.example.com',
        first_name: 'Almaz',
        middle_name: 'Kebede',
        last_name: null,
        username: 'almaz',
      },
    })
  })
  it('leaves restaurant_id null for a tenant caller (the database decides the actor)', () => {
    const r = parseInviteBody(body(invite))
    expect(r.ok && r.value.action === 'invite' && r.value.restaurant_id).toBe(null)
  })
  it('accepts resend / revoke with exactly an invitation id', () => {
    expect(parseInviteBody(body({ action: 'resend', invitation_id: INV.toUpperCase() }))).toEqual({
      ok: true,
      value: { action: 'resend', invitation_id: INV },
    })
    expect(parseInviteBody(body({ action: 'revoke', invitation_id: INV })).ok).toBe(true)
  })
  it.each([
    ['unknown action', { ...invite, action: 'promote' }],
    ['extra key', { ...invite, role_id: RID }],
    ['tenant key smuggled into resend', { action: 'resend', invitation_id: INV, restaurant_id: RID }],
    ['bad restaurant id', { ...invite, restaurant_id: 'x' }],
    ['synthetic identity', { ...invite, email: 'x@central-cafe.staff.cafeos.invalid' }],
    ['no @', { ...invite, email: 'owner.example.com' }],
    ['long e-mail', { ...invite, email: `${'a'.repeat(250)}@example.com` }],
    ['bad username', { ...invite, username: 'A B' }],
    ['blank first name', { ...invite, first_name: '  ' }],
    ['long middle name', { ...invite, middle_name: 'm'.repeat(61) }],
    ['missing username', { action: 'invite', email: 'a@b.co', first_name: 'A' }],
    ['bad invitation id', { action: 'revoke', invitation_id: 'nope' }],
    ['array', [invite]],
  ])('refuses %s', (_label, value) => {
    expect(parseInviteBody(body(value))).toEqual({ ok: false, error: 'invalid_request' })
  })
  it('refuses empty, oversized and non-JSON bodies', () => {
    expect(parseInviteBody('').ok).toBe(false)
    expect(parseInviteBody('{').ok).toBe(false)
    expect(parseInviteBody('x'.repeat(MAX_BODY_BYTES + 1)).ok).toBe(false)
  })
})

describe('RPC result interpretation', () => {
  it('prepare: id, same e-mail, expiry', () => {
    const d = { invitation_id: INV, email: 'a@b.co', restaurant_id: RID, expires_at: '2026-10-15T00:00:00Z' }
    expect(interpretPrepare(d, 'a@b.co')).toEqual({
      invitationId: INV,
      email: 'a@b.co',
      expiresAt: d.expires_at,
    })
    expect(interpretPrepare(d, 'other@b.co')).toBeNull()
    expect(interpretPrepare({ ...d, invitation_id: 'x' }, 'a@b.co')).toBeNull()
    expect(interpretPrepare(null, 'a@b.co')).toBeNull()
  })
  it('resend: must name the same invitation and an attached user', () => {
    expect(interpretResend({ invitation_id: INV, email: 'a@b.co', auth_user_id: USER }, INV)).toEqual({
      email: 'a@b.co',
      authUserId: USER,
    })
    expect(interpretResend({ invitation_id: RID, email: 'a@b.co', auth_user_id: USER }, INV)).toBeNull()
    expect(interpretResend({ invitation_id: INV, email: 'a@b.co', auth_user_id: null }, INV)).toBeNull()
  })
  it('revoke: optional cleanup user', () => {
    expect(interpretRevoke({ invitation_id: INV, status: 'revoked', cleanup_user_id: null }, INV)).toEqual({
      cleanupUserId: null,
    })
    expect(interpretRevoke({ invitation_id: INV, status: 'revoked', cleanup_user_id: USER }, INV)).toEqual({
      cleanupUserId: USER,
    })
    expect(interpretRevoke({ invitation_id: INV, status: 'pending', cleanup_user_id: null }, INV)).toBeNull()
    expect(interpretRevoke({ invitation_id: INV, status: 'revoked', cleanup_user_id: 'x' }, INV)).toBeNull()
  })
})

describe('isDeletableInvitee', () => {
  it('only a never-confirmed user with the expected e-mail', () => {
    expect(isDeletableInvitee({ email: 'a@b.co', email_confirmed_at: null }, 'a@b.co')).toBe(true)
    expect(isDeletableInvitee({ email: 'A@B.co', email_confirmed_at: null }, 'a@b.co')).toBe(true)
    expect(
      isDeletableInvitee({ email: 'a@b.co', email_confirmed_at: '2026-10-08T00:00:00Z' }, 'a@b.co'),
    ).toBe(false)
    expect(isDeletableInvitee({ email: 'a@b.co', confirmed_at: '2026-10-08T00:00:00Z' }, 'a@b.co')).toBe(
      false,
    )
    expect(isDeletableInvitee({ email: 'x@b.co', email_confirmed_at: null }, 'a@b.co')).toBe(false)
    expect(isDeletableInvitee({ email: 'x@b.co', email_confirmed_at: null }, null)).toBe(true)
    expect(isDeletableInvitee(null, null)).toBe(false)
  })
})

describe('isSafeRedirect', () => {
  it.each([
    ['https://app.cafeos.et/invite/accept', true],
    ['http://localhost:5173/invite/accept', true],
    ['http://evil.example.com/accept', false],
    ['https://user:pw@app.cafeos.et/', false],
    ['https://app.cafeos.et/#frag', false],
    ['javascript:alert(1)', false],
    ['', false],
  ])('%s -> %s', (url, ok) => {
    expect(isSafeRedirect(url)).toBe(ok)
  })
})

describe('mapRpcError / shaping', () => {
  it.each([
    ['mfa_required', 'mfa_required'],
    ['permission_denied', 'forbidden'],
    ['tenant_suspended', 'forbidden'],
    ['not_found', 'not_found'],
    ['email_in_use', 'email_in_use'],
    ['username_taken', 'username_taken'],
    ['staff_limit_reached', 'staff_limit_reached'],
    ['invite_rate_limited', 'rate_limited'],
    ['invalid_input', 'invalid_request'],
    ['invalid_state', 'invalid_state'],
    ['relation "x" does not exist', 'server_error'],
    [undefined, 'server_error'],
  ])('%s -> %s', (msg, kind) => {
    expect(mapRpcError(msg)).toBe(kind)
  })
  it('failure bodies are generic, no-store, and rate limits carry Retry-After', () => {
    expect(shapeFailure('mfa_required')).toMatchObject({ status: 403, body: { error: 'mfa_required' } })
    expect(shapeFailure('forbidden_origin').body).toEqual({ error: 'forbidden' })
    const r = shapeFailure('rate_limited', 12.7)
    expect(r.status).toBe(429)
    expect(r.headers['Retry-After']).toBe('12')
    expect(r.headers['Cache-Control']).toBe('no-store')
  })
  it('success bodies are whitelisted', () => {
    expect(shapeSuccess('invite', INV, '2026-10-15T00:00:00Z')).toMatchObject({
      status: 201,
      body: { invitation_id: INV, expires_at: '2026-10-15T00:00:00Z' },
    })
    expect(shapeSuccess('resend', INV).body).toEqual({ invitation_id: INV, resent: true })
    expect(shapeSuccess('revoke', INV).body).toEqual({ invitation_id: INV, status: 'revoked' })
  })
})

describe('readLimitedBody', () => {
  it('reads a small body and refuses an oversized one', async () => {
    const small = new Request('http://x/', { method: 'POST', body: '{"a":1}' })
    expect(await readLimitedBody(small, 64)).toBe('{"a":1}')
    const big = new Request('http://x/', { method: 'POST', body: 'x'.repeat(100) })
    expect(await readLimitedBody(big, 64)).toBeNull()
  })
})
