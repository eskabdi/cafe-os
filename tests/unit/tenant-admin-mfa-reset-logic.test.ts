import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  interpretComplete,
  interpretPrepare,
  mapCompleteError,
  mapRpcError,
  parseMfaResetBody,
  rotationPassword,
  shapeFailure,
  shapeSuccess,
} from '../../supabase/functions/tenant-admin-mfa-reset/logic'

const RID = '11111111-1111-4111-8111-111111111111'
const PID = '44444444-4444-4444-8444-444444444444'
const F1 = '55555555-5555-4555-8555-555555555555'
const F2 = '66666666-6666-4666-8666-666666666666'
const RS = '77777777-7777-4777-8777-777777777777'
const body = (o: unknown) => JSON.stringify(o)

describe('parseMfaResetBody', () => {
  it('accepts exactly { restaurant_id, profile_id, reason }, lower-cases ids and trims the reason', () => {
    expect(
      parseMfaResetBody(
        body({ restaurant_id: RID.toUpperCase(), profile_id: PID.toUpperCase(), reason: '  lost phone  ' }),
      ),
    ).toEqual({
      ok: true,
      value: { restaurant_id: RID, profile_id: PID, reason: 'lost phone' },
    })
  })
  it('counts reason characters, not bytes or UTF-16 units (Amharic, 500 chars)', () => {
    const amharic = 'ሀ'.repeat(500)
    expect(parseMfaResetBody(body({ restaurant_id: RID, profile_id: PID, reason: amharic })).ok).toBe(true)
    expect(parseMfaResetBody(body({ restaurant_id: RID, profile_id: PID, reason: 'ሀ'.repeat(501) })).ok).toBe(
      false,
    )
  })
  it.each([
    ['extra key', { restaurant_id: RID, profile_id: PID, reason: 'lost phone', actor: PID }],
    ['missing restaurant', { profile_id: PID, reason: 'lost phone' }],
    ['missing reason', { restaurant_id: RID, profile_id: PID }],
    ['short reason', { restaurant_id: RID, profile_id: PID, reason: ' x ' }],
    ['long reason', { restaurant_id: RID, profile_id: PID, reason: 'r'.repeat(501) }],
    ['reason not a string', { restaurant_id: RID, profile_id: PID, reason: 42 }],
    ['bad profile id', { restaurant_id: RID, profile_id: 'x', reason: 'lost phone' }],
    ['bad restaurant id', { restaurant_id: 'central-cafe', profile_id: PID, reason: 'lost phone' }],
  ])('refuses %s', (_label, value) => {
    expect(parseMfaResetBody(body(value))).toEqual({ ok: false, error: 'invalid_request' })
  })
  it('refuses oversized, malformed and non-object bodies', () => {
    expect(parseMfaResetBody('x'.repeat(MAX_BODY_BYTES + 1)).ok).toBe(false)
    expect(parseMfaResetBody('').ok).toBe(false)
    expect(parseMfaResetBody('not json').ok).toBe(false)
    expect(parseMfaResetBody('[]').ok).toBe(false)
    expect(parseMfaResetBody('null').ok).toBe(false)
  })
})

describe('interpretPrepare', () => {
  it('accepts the database answer for the requested profile', () => {
    expect(
      interpretPrepare(
        { reset_id: RS.toUpperCase(), profile_id: PID, user_id: PID, factor_ids: [F1, F2.toUpperCase()] },
        PID,
      ),
    ).toEqual({ resetId: RS, userId: PID, factorIds: [F1, F2] })
  })
  it('accepts an empty factor list (finishing a half-done reset: the factors are already gone)', () => {
    expect(interpretPrepare({ reset_id: RS, profile_id: PID, user_id: PID, factor_ids: [] }, PID)).toEqual({
      resetId: RS,
      userId: PID,
      factorIds: [],
    })
  })
  it.each([
    ['another profile', { reset_id: RS, profile_id: F1, user_id: F1, factor_ids: [F1] }],
    ['user id differs', { reset_id: RS, profile_id: PID, user_id: F1, factor_ids: [F1] }],
    ['no reset id', { profile_id: PID, user_id: PID, factor_ids: [F1] }],
    ['bad reset id', { reset_id: 'x', profile_id: PID, user_id: PID, factor_ids: [F1] }],
    ['factor ids not a list', { reset_id: RS, profile_id: PID, user_id: PID, factor_ids: F1 }],
    ['bad factor id', { reset_id: RS, profile_id: PID, user_id: PID, factor_ids: ['x'] }],
    [
      'duplicate factor id',
      { reset_id: RS, profile_id: PID, user_id: PID, factor_ids: [F1, F1.toUpperCase()] },
    ],
    [
      'too many factors',
      {
        reset_id: RS,
        profile_id: PID,
        user_id: PID,
        factor_ids: Array.from({ length: 21 }, (_, i) => `${F1.slice(0, -2)}${String(i).padStart(2, '0')}`),
      },
    ],
    ['null', null],
    ['array', []],
  ])('fails closed on %s', (_label, data) => {
    expect(interpretPrepare(data, PID)).toBeNull()
  })
})

describe('interpretComplete', () => {
  it('accepts counts and a null session count (no privilege on auth.sessions)', () => {
    expect(interpretComplete({ profile_id: PID, sessions_revoked: 2, devices_revoked: 1 }, PID)).toEqual({
      ok: true,
      sessionsRevoked: 2,
      devicesRevoked: 1,
    })
    expect(interpretComplete({ profile_id: PID, sessions_revoked: null, devices_revoked: 0 }, PID)).toEqual({
      ok: true,
      sessionsRevoked: null,
      devicesRevoked: 0,
    })
  })
  it('maps a returned refusal (requester / target no longer qualifies after the factors were deleted)', () => {
    expect(interpretComplete({ profile_id: PID, refused: 'permission_denied' }, PID)).toEqual({
      ok: false,
      kind: 'forbidden',
    })
    expect(interpretComplete({ profile_id: PID, refused: 'not_found' }, PID)).toEqual({
      ok: false,
      kind: 'not_found',
    })
  })
  it.each([
    ['another profile', { profile_id: F1, sessions_revoked: 0, devices_revoked: 0 }],
    ['negative count', { profile_id: PID, sessions_revoked: -1, devices_revoked: 0 }],
    ['fractional count', { profile_id: PID, sessions_revoked: 0, devices_revoked: 1.5 }],
    ['missing devices', { profile_id: PID, sessions_revoked: 0 }],
    ['unknown refusal', { profile_id: PID, refused: 'something' }],
    ['refusal for another profile', { profile_id: F1, refused: 'not_found' }],
    ['null', null],
  ])('fails closed on %s', (_label, data) => {
    expect(interpretComplete(data, PID)).toBeNull()
  })
})

describe('rotationPassword', () => {
  it('is 256 random bits in base64url plus a fixed policy tail, never the same twice', () => {
    const a = rotationPassword()
    const b = rotationPassword()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}aA1!$/)
    expect(new TextEncoder().encode(a).byteLength).toBeLessThanOrEqual(72) // bcrypt limit in GoTrue
  })
  it('uses exactly the injected bytes and refuses short entropy', () => {
    expect(rotationPassword(() => new Uint8Array(32))).toBe(`${'A'.repeat(43)}aA1!`)
    expect(() => rotationPassword(() => new Uint8Array(16))).toThrow('rotation_entropy')
  })
})

describe('mapRpcError / shapeFailure', () => {
  it('maps database codes to safe kinds', () => {
    expect(mapRpcError('mfa_required')).toBe('mfa_required')
    expect(mapRpcError('step_up_required')).toBe('step_up_required')
    expect(mapRpcError('permission_denied')).toBe('forbidden')
    expect(mapRpcError('not_authenticated')).toBe('forbidden')
    expect(mapRpcError('not_found')).toBe('not_found')
    expect(mapRpcError('invalid_state', 'no_factor')).toBe('no_factor')
    expect(mapRpcError('invalid_state', 'something_else')).toBe('server_error')
    expect(mapRpcError('invalid_input', 'reason')).toBe('invalid_request')
    expect(mapRpcError('relation "x" does not exist')).toBe('server_error')
    expect(mapRpcError(undefined)).toBe('server_error')
  })
  it('maps the completion step errors (the reset row is spent / nothing was revoked)', () => {
    expect(mapCompleteError('invalid_state', 'reset_expired')).toBe('reset_expired')
    expect(mapCompleteError('invalid_state', 'reset_superseded')).toBe('reset_expired')
    expect(mapCompleteError('invalid_state', 'reset_completed')).toBe('reset_expired')
    expect(mapCompleteError('invalid_state', 'factors_remain')).toBe('server_error')
    expect(mapCompleteError('permission_denied')).toBe('forbidden')
    expect(mapCompleteError('not_found')).toBe('not_found')
    expect(mapCompleteError('invalid_input', 'reset_id')).toBe('server_error')
    expect(shapeFailure('reset_expired')).toMatchObject({ status: 409, body: { error: 'reset_expired' } })
  })
  it('shapes failures with no-store and no detail', () => {
    expect(shapeFailure('not_found')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    expect(shapeFailure('no_factor')).toMatchObject({ status: 409, body: { error: 'no_factor' } })
    expect(shapeFailure('step_up_required')).toMatchObject({
      status: 403,
      body: { error: 'step_up_required' },
    })
    expect(shapeFailure('forbidden_origin')).toMatchObject({ status: 403, body: { error: 'forbidden' } })
    expect(shapeFailure('payload_too_large')).toMatchObject({
      status: 413,
      body: { error: 'invalid_request' },
    })
    expect(shapeFailure('method_not_allowed').headers.Allow).toBe('POST, OPTIONS')
    expect(shapeFailure('rate_limited', 0.2).headers['Retry-After']).toBe('1')
    expect(shapeFailure('server_error')).toMatchObject({ status: 503, body: { error: 'server_error' } })
    expect(shapeFailure('unauthorized').headers['Cache-Control']).toBe('no-store')
  })
  it('shapes success', () => {
    expect(shapeSuccess(PID, { sessionsRevoked: 3, devicesRevoked: 2 }, 1, true)).toEqual({
      status: 200,
      body: {
        profile_id: PID,
        mfa_reset: true,
        factors_removed: 1,
        sessions_revoked: 3,
        devices_revoked: 2,
        password_rotated: true,
        recovery_sent: true,
      },
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    })
    expect(shapeSuccess(PID, { sessionsRevoked: null, devicesRevoked: 0 }, 0, false).body).toMatchObject({
      sessions_revoked: null,
      password_rotated: true,
      recovery_sent: false,
    })
  })
})
