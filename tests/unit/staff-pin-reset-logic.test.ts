import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  interpretPrepare,
  mapRpcError,
  parsePinResetBody,
  shapeFailure,
  shapeSuccess,
} from '../../supabase/functions/staff-pin-reset/logic'

const PID = '44444444-4444-4444-8444-444444444444'
const body = (o: unknown) => JSON.stringify(o)

describe('parsePinResetBody', () => {
  it('accepts exactly { profile_id, pin }', () => {
    expect(parsePinResetBody(body({ profile_id: PID.toUpperCase(), pin: '4829' }))).toEqual({
      ok: true,
      value: { profile_id: PID, pin: '4829' },
    })
    expect(parsePinResetBody(body({ profile_id: PID, pin: '480516' })).ok).toBe(true)
  })
  it('refuses weak PINs (repeated, sequential, common)', () => {
    for (const pin of ['1111', '1234', '4321', '2580', '123456', '121212']) {
      expect(parsePinResetBody(body({ profile_id: PID, pin }))).toEqual({ ok: false, error: 'weak_pin' })
    }
  })
  it.each([
    ['extra key', { profile_id: PID, pin: '4829', role_id: PID }],
    ['tenant smuggled', { profile_id: PID, pin: '4829', restaurant_id: PID }],
    ['5 digits', { profile_id: PID, pin: '48291' }],
    ['letters', { profile_id: PID, pin: '48a9' }],
    ['number type', { profile_id: PID, pin: 4829 }],
    ['bad id', { profile_id: 'x', pin: '4829' }],
    ['missing pin', { profile_id: PID }],
  ])('refuses %s', (_label, value) => {
    expect(parsePinResetBody(body(value))).toEqual({ ok: false, error: 'invalid_request' })
  })
  it('refuses oversized / malformed bodies', () => {
    expect(parsePinResetBody('x'.repeat(MAX_BODY_BYTES + 1)).ok).toBe(false)
    expect(parsePinResetBody('not json').ok).toBe(false)
  })
})

describe('interpretPrepare', () => {
  it('the SQL and TypeScript length rules must agree (fail closed otherwise)', () => {
    expect(interpretPrepare({ profile_id: PID, role_name: 'Cashier', pin_length: 6 }, PID)).toEqual({
      pinLength: 6,
    })
    expect(interpretPrepare({ profile_id: PID, role_name: 'Line Cook', pin_length: 4 }, PID)).toEqual({
      pinLength: 4,
    })
    expect(interpretPrepare({ profile_id: PID, role_name: 'Cashier', pin_length: 4 }, PID)).toBeNull()
    expect(interpretPrepare({ profile_id: PID, role_name: 'Runner', pin_length: 6 }, PID)).toBeNull()
  })
  it('must name the requested profile', () => {
    expect(
      interpretPrepare(
        { profile_id: '55555555-5555-4555-8555-555555555555', role_name: 'Runner', pin_length: 4 },
        PID,
      ),
    ).toBeNull()
    expect(interpretPrepare(null, PID)).toBeNull()
  })
})

describe('errors and responses', () => {
  it.each([
    ['mfa_required', 'mfa_required'],
    ['permission_denied', 'forbidden'],
    ['permission_escalation', 'forbidden'],
    ['not_found', 'not_found'],
    ['pin_not_allowed', 'pin_not_allowed'],
    ['invalid_state', 'pin_not_allowed'],
    ['invalid_input', 'invalid_request'],
    ['boom', 'server_error'],
  ])('%s -> %s', (msg, kind) => {
    expect(mapRpcError(msg)).toBe(kind)
  })
  it('never echoes the PIN', () => {
    expect(shapeSuccess(PID).body).toEqual({ profile_id: PID, pin_reset: true })
    expect(shapeFailure('invalid_pin_length')).toMatchObject({
      status: 400,
      body: { error: 'invalid_pin_length' },
    })
  })
})
