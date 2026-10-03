import { describe, expect, it } from 'vitest'
import {
  IP_LIMIT,
  MAX_BODY_BYTES,
  MIN_RESPONSE_MS,
  RESPONSE_JITTER_MS,
  USER_LIMIT,
  checkRateLimits,
  clientIp,
  createPinLoginLimiters,
  createRateLimiter,
  interpretVerifyResult,
  isPinCandidate,
  isSyntheticStaffEmail,
  parsePinLoginBody,
  remainingDelayMs,
  shapeFailure,
  shapeSuccess,
} from '../../supabase/functions/pin-login/logic'
import {
  computePinDigest,
  isLocalSupabaseUrl,
  isPepperAllowedFor,
  isUsablePepper,
  isWeakPin,
  pinLengthForRole,
  isPinAcceptableForRole,
  CASHIER_ROLE_NAME,
  DEMO_PEPPER,
} from '../../supabase/functions/_shared/pin'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../../supabase/functions/_shared/cors'
import { PIN_PATTERN, USERNAME_PATTERN } from '../../src/lib/supabase/pin-login-errors'

const TENANT = '11111111-1111-4111-8111-111111111111'
const PROFILE = '22222222-2222-4222-8222-222222222222'
const body = (o: unknown) => JSON.stringify(o)
const valid = { restaurant_slug: 'demo-cafe', username: 'abebe', pin: '4829' }

describe('parsePinLoginBody', () => {
  it('accepts a valid body and normalizes slug/username', () => {
    const r = parsePinLoginBody(body({ restaurant_slug: ' Demo-Cafe ', username: ' Abebe.K ', pin: '4829' }))
    expect(r).toEqual({
      ok: true,
      value: { restaurant_slug: 'demo-cafe', username: 'abebe.k', pin: '4829' },
    })
  })

  it.each([
    ['3 digits', { ...valid, pin: '123' }],
    ['5 digits (only 4 or 6 exist)', { ...valid, pin: '48290' }],
    ['7 digits (maximum is 6)', { ...valid, pin: '4829037' }],
    ['letters in pin', { ...valid, pin: '12a4' }],
    ['numeric pin', { ...valid, pin: 1234 }],
    ['Arabic-Indic digits', { ...valid, pin: '١٢٣٤' }],
    ['pin with space', { ...valid, pin: '12 34' }],
    ['bad slug chars', { ...valid, restaurant_slug: 'demo_cafe' }],
    ['double hyphen slug', { ...valid, restaurant_slug: 'de--mo' }],
    ['one-char username', { ...valid, username: 'a' }],
    ['username with space', { ...valid, username: 'a b' }],
    ['missing pin', { restaurant_slug: 'demo-cafe', username: 'abebe' }],
    ['extra key', { ...valid, restaurant_id: TENANT }],
  ])('rejects %s', (_n, input) => {
    expect(parsePinLoginBody(body(input))).toEqual({ ok: false, error: 'invalid_request' })
  })

  it('rejects non-objects, bad JSON, empty and oversized bodies', () => {
    for (const t of ['', 'nope', '[]', 'null', '"x"', '1']) {
      expect(parsePinLoginBody(t).ok).toBe(false)
    }
    const big = body({ ...valid, username: 'a'.repeat(MAX_BODY_BYTES) })
    expect(parsePinLoginBody(big).ok).toBe(false)
  })

  it('client-side patterns agree with the server on sample vectors', () => {
    for (const u of ['abebe', 'a.b-c_1', 'ab', 'a', 'A', 'a b', '-ab', 'x'.repeat(32), 'x'.repeat(33)]) {
      const server = parsePinLoginBody(body({ ...valid, username: u })).ok
      expect(USERNAME_PATTERN.test(u.trim().toLowerCase())).toBe(server)
    }
    // the client pattern may be looser (UX only) but must never reject what the server accepts
    for (const p of ['1234', '4829', '480516', '12345', '123', 'abcd', '12 4']) {
      if (parsePinLoginBody(body({ ...valid, pin: p })).ok) expect(PIN_PATTERN.test(p)).toBe(true)
    }
  })
})

describe('rate limiter', () => {
  it('allows a burst then blocks with a retry hint, and refills over time', () => {
    let t = 0
    const rl = createRateLimiter({ capacity: 3, refillPerSec: 1, maxKeys: 10 }, () => t)
    expect([rl.take('a').allowed, rl.take('a').allowed, rl.take('a').allowed]).toEqual([true, true, true])
    const blocked = rl.take('a')
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(rl.take('b').allowed).toBe(true) // independent key
    t += 1000
    expect(rl.take('a').allowed).toBe(true)
    expect(rl.take('a').allowed).toBe(false)
  })

  it('bounds memory by evicting the least recently used key', () => {
    const rl = createRateLimiter({ capacity: 1, refillPerSec: 0.001, maxKeys: 3 }, () => 0)
    for (const k of ['a', 'b', 'c', 'd']) rl.take(k)
    expect(rl.size()).toBe(3)
  })

  it('throttles per IP and per tenant+username independently', () => {
    let t = 0
    const limiters = createPinLoginLimiters(() => t)
    const input = parsePinLoginBody(body(valid))
    if (!input.ok) throw new Error('fixture')
    for (let i = 0; i < USER_LIMIT.capacity; i++)
      expect(checkRateLimits(limiters, `ip${i}`, input.value).allowed).toBe(true)
    // same username from a fresh IP is throttled by the per-username bucket
    expect(checkRateLimits(limiters, 'fresh', input.value).allowed).toBe(false)
    // a different username from a fresh IP is fine
    expect(checkRateLimits(limiters, 'fresh2', { ...input.value, username: 'other' }).allowed).toBe(true)
    // one IP hammering many usernames hits the IP bucket
    const l2 = createPinLoginLimiters(() => t)
    let denied = 0
    for (let i = 0; i < IP_LIMIT.capacity + 5; i++) {
      if (!checkRateLimits(l2, 'same-ip', { ...input.value, username: `user${i}` }).allowed) denied++
    }
    expect(denied).toBe(5)
    t += 60_000
    expect(checkRateLimits(l2, 'same-ip', { ...input.value, username: 'user0' }).allowed).toBe(true)
  })

  it('derives a bounded client IP', () => {
    const h = (m: Record<string, string>) => ({ get: (n: string) => m[n] ?? null })
    expect(clientIp(h({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4')
    expect(clientIp(h({ 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' }))).toBe('9.9.9.9')
    expect(clientIp(h({}))).toBe('unknown')
    expect(clientIp(h({ 'x-real-ip': 'x'.repeat(500) })).length).toBe(64)
  })
})

describe('verify result interpretation and admin refusal', () => {
  const expected = { profileId: PROFILE, restaurantId: TENANT }
  const ok = { status: 'ok', profile: { id: PROFILE, restaurant_id: TENANT, username: 'abebe' } }

  it('accepts only a well-formed ok for the requested profile and tenant', () => {
    expect(interpretVerifyResult(ok, expected)).toEqual({
      kind: 'ok',
      profileId: PROFILE,
      restaurantId: TENANT,
    })
  })

  it.each([
    ['invalid', { status: 'invalid', attempts_left: 2 }],
    ['locked', { status: 'locked', locked_until: '2030-01-01' }],
    ['inactive', { status: 'inactive' }],
    ['null', null],
    ['string', 'ok'],
    ['ok without profile', { status: 'ok' }],
    ['other profile', { status: 'ok', profile: { id: TENANT, restaurant_id: TENANT } }],
    ['other tenant', { status: 'ok', profile: { id: PROFILE, restaurant_id: PROFILE } }],
  ])('denies %s identically', (_n, result) => {
    expect(interpretVerifyResult(result, expected)).toEqual({ kind: 'denied' })
  })

  it('refuses admins and non-PIN profiles before any PIN check (same path as unknown user)', () => {
    const base = { id: PROFILE, restaurant_id: TENANT, auth_method: 'pin', is_active: true }
    expect(isPinCandidate(base, TENANT)).toBe(true)
    expect(isPinCandidate({ ...base, auth_method: 'password' }, TENANT)).toBe(false) // tenant_admin
    expect(isPinCandidate({ ...base, is_active: false }, TENANT)).toBe(false)
    expect(isPinCandidate({ ...base, restaurant_id: PROFILE }, TENANT)).toBe(false)
    expect(isPinCandidate(null, TENANT)).toBe(false)
    expect(isPinCandidate({ ...base, id: 'not-a-uuid' }, TENANT)).toBe(false)
  })

  it('only synthetic staff emails may be minted', () => {
    expect(isSyntheticStaffEmail('u1@demo-cafe.staff.cafeos.invalid')).toBe(true)
    expect(isSyntheticStaffEmail('owner@example.com')).toBe(false)
    expect(isSyntheticStaffEmail(undefined)).toBe(false)
  })
})

describe('response shaping', () => {
  it('every credential failure is byte-identical', () => {
    const a = shapeFailure('invalid_credentials')
    expect(a.status).toBe(401)
    expect(JSON.stringify(a.body)).toBe('{"error":"invalid_credentials"}')
    expect(a.headers['Cache-Control']).toBe('no-store')
  })

  it('rate limiting returns generic try_later with Retry-After', () => {
    const r = shapeFailure('rate_limited', 12.7)
    expect(r.status).toBe(429)
    expect(r.body).toEqual({ error: 'try_later' })
    expect(r.headers['Retry-After']).toBe('12')
  })

  it('success whitelists exactly three fields', () => {
    const r = shapeSuccess({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 3600.9,
      token_type: 'bearer',
      user: { id: 'x', email: 'y' },
      provider_token: 'secret',
    })
    expect(r?.status).toBe(200)
    expect(Object.keys(r?.body ?? {}).sort()).toEqual(['access_token', 'expires_in', 'refresh_token'])
    expect(r?.body.expires_in).toBe(3600)
  })

  it.each([
    null,
    {},
    { access_token: 'a' },
    { access_token: 'a', refresh_token: 'r', expires_in: 0 },
    { access_token: 1, refresh_token: 'r', expires_in: 5 },
  ])('rejects malformed session %j', (s) => expect(shapeSuccess(s)).toBeNull())

  it('failure bodies never contain tokens or detail', () => {
    for (const k of [
      'invalid_request',
      'payload_too_large',
      'method_not_allowed',
      'forbidden_origin',
      'server_error',
      'invalid_credentials',
      'rate_limited',
    ] as const) {
      expect(Object.keys(shapeFailure(k).body)).toEqual(['error'])
    }
  })
})

describe('timing floor', () => {
  it('pads fast responses to the floor plus jitter and never waits when already slow', () => {
    expect(remainingDelayMs(0, 0, () => 0)).toBe(MIN_RESPONSE_MS)
    expect(remainingDelayMs(0, 100, () => 0)).toBe(MIN_RESPONSE_MS - 100)
    expect(remainingDelayMs(0, 0, () => 0.999)).toBeLessThan(MIN_RESPONSE_MS + RESPONSE_JITTER_MS)
    expect(remainingDelayMs(0, 5000, () => 0.5)).toBe(0)
  })
})

describe('CORS', () => {
  it('has no wildcard: "*" is ignored and unknown origins are refused', () => {
    const allowed = parseAllowedOrigins(
      '*, https://app.example.com/ , http://localhost:5173, ftp://x, nonsense',
    )
    expect(allowed).toEqual(['https://app.example.com', 'http://localhost:5173'])
    expect(resolveAllowedOrigin('https://app.example.com', allowed)).toBe('https://app.example.com')
    expect(resolveAllowedOrigin('https://evil.example.com', allowed)).toBeNull()
    expect(resolveAllowedOrigin(null, allowed)).toBeNull()
  })

  it('unset env allows nothing; headers never echo "*"', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([])
    expect(parseAllowedOrigins('*')).toEqual([])
    expect(corsHeaders(null)['Access-Control-Allow-Origin']).toBeUndefined()
    expect(corsHeaders('https://app.example.com')['Access-Control-Allow-Origin']).toBe(
      'https://app.example.com',
    )
  })
})

describe('peppered PIN digest', () => {
  it('matches the HMAC-SHA256 vector the pgTAP suite checks against SQL (hex, 64 chars)', async () => {
    expect(await computePinDigest('480516', DEMO_PEPPER)).toBe(
      '4f633837f6f2abccc01eab0a980ee22939c23ae3759d067cbd0641a9eb82d0cb',
    )
  })
  it('depends on the pepper and on the PIN', async () => {
    const a = await computePinDigest('4829', DEMO_PEPPER)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await computePinDigest('4829', DEMO_PEPPER + 'x')).not.toBe(a)
    expect(await computePinDigest('4830', DEMO_PEPPER)).not.toBe(a)
  })
  it('requires a long pepper', () => {
    expect(isUsablePepper(undefined)).toBe(false)
    expect(isUsablePepper('short')).toBe(false)
    expect(isUsablePepper(DEMO_PEPPER)).toBe(true) // long enough to run locally; the seed guard keeps it off hosted projects
    expect(isUsablePepper('x'.repeat(32))).toBe(true)
  })
})

describe('isWeakPin', () => {
  it.each([
    '0000',
    '1111',
    '1234',
    '4321',
    '1212',
    '1122',
    '2580',
    '0123',
    '6789',
    '9876',
    '2468',
    '123',
    '12345',
    'abcd',
    '123456',
  ])('rejects %s', (p) => expect(isWeakPin(p)).toBe(true))
  it.each(['4829', '7392', '6028', '9153', '8510', '480516', '264813'])('accepts %s', (p) =>
    expect(isWeakPin(p)).toBe(false),
  )
})

describe('demo pepper is local-only', () => {
  it.each([
    'http://127.0.0.1:54321',
    'http://localhost:54321',
    'http://kong:8000',
    'http://host.docker.internal:54321',
  ])('local: %s', (u) => {
    expect(isLocalSupabaseUrl(u)).toBe(true)
    expect(isPepperAllowedFor(DEMO_PEPPER, u)).toBe(true)
  })
  it.each(['https://abcd.supabase.co', 'https://localhost.evil.com', 'not a url', '', undefined])(
    'hosted/unknown: %s',
    (u) => {
      expect(isPepperAllowedFor(DEMO_PEPPER, u)).toBe(false)
    },
  )
  it('any other pepper is fine anywhere', () => {
    expect(isPepperAllowedFor('x'.repeat(40), 'https://abcd.supabase.co')).toBe(true)
  })
})

describe('PIN length by role (documented Cashier exception)', () => {
  it('Cashier needs 6 digits, every other role exactly 4', () => {
    expect(CASHIER_ROLE_NAME).toBe('Cashier')
    expect(pinLengthForRole('Cashier')).toBe(6)
    expect(pinLengthForRole('  cashier ')).toBe(6) // same normalisation as roles.normalized_name
    expect(pinLengthForRole('CASHIER')).toBe(6)
    for (const n of ['Waiter', 'Kitchen', 'Bar', 'Cashier Assistant', 'Cashiers', '', null, undefined]) {
      expect(pinLengthForRole(n)).toBe(4)
    }
  })
  it('applies length AND the weak-PIN rules', () => {
    expect(isPinAcceptableForRole('4829', 'Waiter')).toBe(true)
    expect(isPinAcceptableForRole('480516', 'Waiter')).toBe(false)
    expect(isPinAcceptableForRole('480516', 'Cashier')).toBe(true)
    expect(isPinAcceptableForRole('4829', 'Cashier')).toBe(false)
    expect(isPinAcceptableForRole('123456', 'Cashier')).toBe(false)
    expect(isPinAcceptableForRole('111111', 'Cashier')).toBe(false)
    expect(isPinAcceptableForRole('121212', 'Cashier')).toBe(false)
    expect(isPinAcceptableForRole('1234', 'Waiter')).toBe(false)
  })
  it('pin-login accepts both lengths on the wire (it cannot know the user)', () => {
    expect(parsePinLoginBody(JSON.stringify({ ...valid, pin: '480516' })).ok).toBe(true)
    expect(parsePinLoginBody(JSON.stringify({ ...valid, pin: '4829' })).ok).toBe(true)
  })
})
