import { describe, expect, it } from 'vitest'
import {
  MAX_BODY_BYTES,
  extractBearer,
  interpretPrepare,
  pinLengthMatchesRole,
  mapRpcError,
  parseStaffCreateBody,
  randomPassword,
  shapeFailure,
  shapeSuccess,
  staffEmail,
} from '../../supabase/functions/staff-create/logic'

const ROLE = '33333333-3333-4333-8333-333333333333'
const valid = { username: 'abebe', first_name: 'Abebe', role_id: ROLE, pin: '4829' }
const body = (o: unknown) => JSON.stringify(o)

describe('parseStaffCreateBody', () => {
  it('accepts a minimal and a full body, normalizing', () => {
    expect(parseStaffCreateBody(body(valid))).toEqual({
      ok: true,
      value: {
        username: 'abebe',
        first_name: 'Abebe',
        middle_name: null,
        last_name: null,
        role_id: ROLE,
        pin: '4829',
      },
    })
    const r = parseStaffCreateBody(
      body({
        ...valid,
        username: ' Abebe.K ',
        middle_name: ' Worku ',
        last_name: '',
        role_id: ROLE.toUpperCase(),
      }),
    )
    expect(r).toEqual({
      ok: true,
      value: {
        username: 'abebe.k',
        first_name: 'Abebe',
        middle_name: 'Worku',
        last_name: null,
        role_id: ROLE,
        pin: '4829',
      },
    })
  })
  it.each([
    ['missing pin', { username: 'abebe', first_name: 'A', role_id: ROLE }],
    ['extra key (tenant id from the client)', { ...valid, restaurant_id: ROLE }],
    ['extra key (email)', { ...valid, email: 'a@b.co' }],
    ['bad username', { ...valid, username: 'a b' }],
    ['bad role id', { ...valid, role_id: 'nope' }],
    ['blank first name', { ...valid, first_name: '  ' }],
    ['long name', { ...valid, first_name: 'x'.repeat(61) }],
    ['numeric pin', { ...valid, pin: 4829 }],
    ['short pin', { ...valid, pin: '482' }],
    ['non-string middle name', { ...valid, middle_name: 5 }],
  ])('rejects %s', (_n, input) => {
    expect(parseStaffCreateBody(body(input))).toEqual({ ok: false, error: 'invalid_request' })
  })
  it('accepts a 6-digit PIN at parse time (the length vs role check happens after the server-side role lookup)', () => {
    expect(parseStaffCreateBody(body({ ...valid, pin: '480516' })).ok).toBe(true)
    expect(parseStaffCreateBody(body({ ...valid, pin: '48291' })).ok).toBe(false)
  })
  it.each(['000000', '123456', '121212', '654321'])('reports weak_pin for the 6-digit %s', (pin) => {
    expect(parseStaffCreateBody(body({ ...valid, pin }))).toEqual({ ok: false, error: 'weak_pin' })
  })
  it.each(['0000', '1234', '1212', '4321'])('reports weak_pin for %s', (pin) => {
    expect(parseStaffCreateBody(body({ ...valid, pin }))).toEqual({ ok: false, error: 'weak_pin' })
  })
  it('rejects empty, malformed, non-object and oversized input', () => {
    for (const t of ['', 'x', '[]', 'null', '1']) expect(parseStaffCreateBody(t).ok).toBe(false)
    expect(parseStaffCreateBody(body({ ...valid, first_name: 'a'.repeat(MAX_BODY_BYTES) })).ok).toBe(false)
  })
})

describe('staffEmail', () => {
  it('builds the synthetic identity the database requires', () => {
    expect(staffEmail('abebe', 'central-cafe')).toBe('abebe@central-cafe.staff.cafeos.invalid')
  })
  it('refuses malformed parts (no injection of a real domain)', () => {
    expect(staffEmail('a@evil.com', 'central-cafe')).toBeNull()
    expect(staffEmail('abebe', 'evil.com/')).toBeNull()
    expect(staffEmail('abebe', 'a--b')).toBeNull()
    expect(staffEmail('', 'central-cafe')).toBeNull()
  })
})

describe('randomPassword', () => {
  it('is 32 random bytes as base64url (43 chars, no padding) and differs per call', () => {
    const a = randomPassword()
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(randomPassword()).not.toBe(a)
  })
  it('uses the injected entropy source', () => {
    expect(randomPassword((b) => b.fill(0))).toBe('A'.repeat(43))
  })
})

describe('extractBearer', () => {
  const jwt = 'aaa.bbb.ccc'
  it('extracts a well-formed bearer token', () => expect(extractBearer(`Bearer ${jwt}`)).toBe(jwt))
  it.each([null, undefined, '', 'Bearer', 'Basic x', 'Bearer a.b', 'Bearer a b.c.d', `bearer ${jwt}`])(
    'rejects %s',
    (h) => expect(extractBearer(h as string | null | undefined)).toBeNull(),
  )
})

describe('interpretPrepare', () => {
  it('accepts the exact shape', () =>
    expect(
      interpretPrepare({ slug: 'central-cafe', username: 'abebe', role_name: 'Waiter' }, 'abebe'),
    ).toEqual({
      slug: 'central-cafe',
      roleName: 'Waiter',
    }))
  it.each([
    null,
    'x',
    {},
    { slug: 'A B', username: 'abebe', role_name: 'W' },
    { slug: 'central-cafe', username: 'other', role_name: 'W' },
    { slug: 'central-cafe', username: 'abebe' },
    { slug: 'central-cafe', username: 'abebe', role_name: '' },
  ])('rejects %j', (d) => expect(interpretPrepare(d, 'abebe')).toBeNull())
})

describe('pinLengthMatchesRole', () => {
  it('Cashier: 6 digits; others: 4', () => {
    expect(pinLengthMatchesRole('480516', 'Cashier')).toBe(true)
    expect(pinLengthMatchesRole('4829', 'Cashier')).toBe(false)
    expect(pinLengthMatchesRole('4829', 'Waiter')).toBe(true)
    expect(pinLengthMatchesRole('480516', 'Waiter')).toBe(false)
  })
})

describe('mapRpcError / shaping', () => {
  it('maps actionable codes and collapses the rest', () => {
    expect(mapRpcError('permission_denied')).toBe('forbidden')
    expect(mapRpcError('tenant_suspended')).toBe('forbidden')
    expect(mapRpcError('mfa_required')).toBe('mfa_required')
    expect(mapRpcError('username_taken')).toBe('username_taken')
    expect(mapRpcError('staff_limit_reached')).toBe('staff_limit_reached')
    expect(mapRpcError('invalid_role')).toBe('invalid_request')
    expect(mapRpcError('invalid_auth_user')).toBe('server_error')
    expect(mapRpcError('relation "profiles" does not exist')).toBe('server_error')
    expect(mapRpcError(undefined)).toBe('server_error')
  })
  it('has one fixed body per failure and a Retry-After for throttling', () => {
    expect(shapeFailure('unauthorized')).toMatchObject({ status: 401, body: { error: 'unauthorized' } })
    expect(shapeFailure('weak_pin').body).toEqual({ error: 'weak_pin' })
    expect(shapeFailure('invalid_pin_length')).toMatchObject({
      status: 400,
      body: { error: 'invalid_pin_length' },
    })
    const r = shapeFailure('rate_limited', 12.7)
    expect(r.status).toBe(429)
    expect(r.headers['Retry-After']).toBe('12')
    expect(shapeFailure('server_error').status).toBe(503)
  })
  it('returns only the profile id on success', () => {
    const id = '44444444-4444-4444-8444-444444444444'
    expect(shapeSuccess(id)).toMatchObject({ status: 201, body: { profile_id: id } })
    expect(Object.keys(shapeSuccess(id)?.body ?? {})).toEqual(['profile_id'])
    expect(shapeSuccess('nope')).toBeNull()
    expect(shapeSuccess({ id })).toBeNull()
  })
})
