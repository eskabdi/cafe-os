import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  extractBearer,
  interpretCompleteResult,
  isChangeCandidate,
  parsePinChangeBody,
  pinLengthOk,
  shapeFailure,
  shapeSuccess,
} from '../../supabase/functions/pin-change/logic'
import { CASHIER_ROLE_NAME } from '../../supabase/functions/_shared/pin'

const body = (o: unknown) => JSON.stringify(o)
const UID = '11111111-1111-4111-8111-111111111111'
const TENANT = '22222222-2222-4222-8222-222222222222'
const ROLE = '33333333-3333-4333-8333-333333333333'

describe('parsePinChangeBody', () => {
  it('accepts exactly {current_pin, new_pin} with 4 or 6 digits', () => {
    expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: '7391' }))).toEqual({
      ok: true,
      value: { current_pin: '4829', new_pin: '7391' },
    })
    expect(parsePinChangeBody(body({ current_pin: '834921', new_pin: '472913' })).ok).toBe(true)
  })

  it('rejects unknown, missing or extra keys (no id, no user_id: identity comes from the JWT only)', () => {
    expect(parsePinChangeBody(body({ current_pin: '4829' }))).toEqual({ ok: false, error: 'invalid_request' })
    expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: '7391', user_id: UID }))).toEqual({
      ok: false,
      error: 'invalid_request',
    })
    expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: '7391', profile_id: UID }))).toEqual({
      ok: false,
      error: 'invalid_request',
    })
  })

  it('rejects malformed input', () => {
    for (const t of [
      '',
      'nope',
      '[]',
      'null',
      '"x"',
      body({ current_pin: 4829, new_pin: '7391' }),
      body({ current_pin: '4829', new_pin: ['7391'] }),
    ]) {
      expect(parsePinChangeBody(t)).toEqual({ ok: false, error: 'invalid_request' })
    }
    for (const pin of ['123', '12345', '1234567', 'abcd', '48 9', '４８２９', '4829\n']) {
      expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: pin })).ok).toBe(false)
      expect(parsePinChangeBody(body({ current_pin: pin, new_pin: '7391' })).ok).toBe(false)
    }
  })

  it('enforces the body size cap', () => {
    expect(
      parsePinChangeBody(body({ current_pin: '4829', new_pin: '7391', pad: 'x'.repeat(MAX_BODY_BYTES) })).ok,
    ).toBe(false)
  })

  it('applies the weak-PIN policy to the NEW pin only (4 and 6 digits)', () => {
    for (const weak of ['1234', '1111', '0000', '4321', '1212', '123456', '111111', '121212']) {
      expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: weak }))).toEqual({
        ok: false,
        error: 'weak_pin',
      })
    }
    // a weak CURRENT pin is not this function's business (it may be a legacy PIN); it just has to verify
    expect(parsePinChangeBody(body({ current_pin: '1234', new_pin: '7391' })).ok).toBe(true)
  })

  it('refuses a new PIN equal to the current one', () => {
    expect(parsePinChangeBody(body({ current_pin: '4829', new_pin: '4829' }))).toEqual({
      ok: false,
      error: 'same_pin',
    })
  })
})

describe('pinLengthOk (reuses _shared/pin.ts; no second role-name literal)', () => {
  it('4 digits for ordinary roles, 6 for the documented Cashier exception', () => {
    expect(pinLengthOk('4829', 'Waiter')).toBe(true)
    expect(pinLengthOk('482913', 'Waiter')).toBe(false)
    expect(pinLengthOk('482913', CASHIER_ROLE_NAME)).toBe(true)
    expect(pinLengthOk('4829', CASHIER_ROLE_NAME)).toBe(false)
    expect(pinLengthOk('482913', '  cashier ')).toBe(true)
  })
  it('an unknown role name never passes', () => {
    expect(pinLengthOk('4829', null)).toBe(false)
    expect(pinLengthOk('4829', '')).toBe(false)
    expect(pinLengthOk('4829', 42)).toBe(false)
  })
})

describe('isChangeCandidate', () => {
  const ok = { id: UID, restaurant_id: TENANT, role_id: ROLE, auth_method: 'pin', is_active: true }
  it("only the caller's own active PIN profile", () => {
    expect(isChangeCandidate(ok, UID)).toBe(true)
    expect(isChangeCandidate({ ...ok, id: TENANT }, UID)).toBe(false)
    expect(isChangeCandidate({ ...ok, auth_method: 'password' }, UID)).toBe(false)
    expect(isChangeCandidate({ ...ok, is_active: false }, UID)).toBe(false)
    expect(isChangeCandidate({ ...ok, role_id: 'x' }, UID)).toBe(false)
    expect(isChangeCandidate(null, UID)).toBe(false)
    expect(isChangeCandidate('x', UID)).toBe(false)
  })
})

describe('response shaping', () => {
  it('failure bodies are fixed and never carry detail; everything is no-store', () => {
    const kinds = [
      'invalid_request',
      'weak_pin',
      'same_pin',
      'invalid_pin_length',
      'unauthorized',
      'invalid_credentials',
      'forbidden_origin',
      'payload_too_large',
      'method_not_allowed',
      'rate_limited',
      'server_error',
    ] as const
    for (const k of kinds) {
      const r = shapeFailure(k, 12)
      expect(r.headers['Cache-Control']).toBe('no-store')
      expect(Object.keys(r.body)).toEqual(['error'])
    }
    expect(shapeFailure('invalid_credentials')).toEqual({
      status: 401,
      body: { error: 'invalid_credentials' },
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    })
    expect(shapeFailure('rate_limited', 12).status).toBe(429)
    expect(shapeFailure('rate_limited', 12).headers['Retry-After']).toBe('12')
    expect(shapeFailure('unauthorized').status).toBe(401)
    expect(shapeFailure('weak_pin').status).toBe(400)
  })
  it('success reports only changed + pending_approval + other_sessions_revoked', () => {
    expect(shapeSuccess(true, true)).toEqual({
      status: 200,
      body: { changed: true, pending_approval: true, other_sessions_revoked: true },
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' },
    })
    expect(shapeSuccess(false, false).body).toEqual({
      changed: true,
      pending_approval: false,
      other_sessions_revoked: false,
    })
    expect(shapeSuccess(true, false).body).toEqual({
      changed: true,
      pending_approval: true,
      other_sessions_revoked: false,
    })
    expect(Object.keys(shapeSuccess(false, true).body)).toEqual([
      'changed',
      'pending_approval',
      'other_sessions_revoked',
    ])
  })
  it('interprets fn_complete_forced_pin_change strictly (anything unexpected is null, never "not pending")', () => {
    expect(interpretCompleteResult({ pending_approval: true })).toBe(true)
    expect(interpretCompleteResult({ pending_approval: false })).toBe(false)
    for (const bad of [
      null,
      undefined,
      [],
      'true',
      1,
      {},
      { pending_approval: 'true' },
      { pending_approval: null },
    ]) {
      expect(interpretCompleteResult(bad)).toBeNull()
    }
  })
  it('re-exports the bearer parser used by staff-create', () => {
    expect(extractBearer('Bearer a.b.c')).toBe('a.b.c')
    expect(extractBearer('Bearer nope')).toBeNull()
    expect(extractBearer(null)).toBeNull()
  })
})
