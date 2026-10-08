import { describe, expect, it } from 'vitest'
import { KIOSK_TOKEN_RE, kioskTokenHash } from '../../supabase/functions/_shared/kiosk'
import {
  PIN_PAD_IDLE_DEFAULT_SECONDS,
  PIN_PAD_IDLE_MAX_SECONDS,
  PIN_PAD_IDLE_MIN_SECONDS,
  PRIVATE_HEADERS,
  normalizePinPadIdleSeconds,
  parseRosterBody,
  shapeFailure,
  shapeRoster,
  shapeSuccess,
  shapeTiles,
} from '../../supabase/functions/staff-roster/logic'
import {
  isTileLogin,
  parsePinLoginBody,
  checkRateLimits,
  createPinLoginLimiters,
} from '../../supabase/functions/pin-login/logic'

const TOKEN = 'a'.repeat(64)
const PROFILE = '22222222-2222-4222-8222-222222222222'
const body = (o: unknown) => JSON.stringify(o)

describe('kiosk token', () => {
  it('is 64 lowercase hex; its hash is sha256 of the TEXT (same value the SQL test computes)', async () => {
    expect(KIOSK_TOKEN_RE.test(TOKEN)).toBe(true)
    for (const t of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), ''])
      expect(KIOSK_TOKEN_RE.test(t)).toBe(false)
    expect(await kioskTokenHash(TOKEN)).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    )
  })
})

describe('parseRosterBody', () => {
  it('accepts exactly {restaurant_slug, kiosk_token} and normalizes the slug', () => {
    expect(parseRosterBody(body({ restaurant_slug: ' Central-Cafe ', kiosk_token: TOKEN }))).toEqual({
      ok: true,
      value: { restaurant_slug: 'central-cafe', kiosk_token: TOKEN },
    })
  })
  it.each([
    ['extra key', { restaurant_slug: 'central-cafe', kiosk_token: TOKEN, username: 'x' }],
    ['missing token', { restaurant_slug: 'central-cafe' }],
    ['bad token', { restaurant_slug: 'central-cafe', kiosk_token: 'nope' }],
    ['bad slug', { restaurant_slug: 'a--b', kiosk_token: TOKEN }],
    ['numeric slug', { restaurant_slug: 5, kiosk_token: TOKEN }],
  ])('rejects %s', (_n, o) => expect(parseRosterBody(body(o)).ok).toBe(false))
  it('rejects junk and oversize', () => {
    for (const t of ['', 'x', '[]', 'null']) expect(parseRosterBody(t).ok).toBe(false)
    expect(
      parseRosterBody(body({ restaurant_slug: 'central-cafe', kiosk_token: TOKEN, pad: 'x'.repeat(600) })).ok,
    ).toBe(false)
  })
})

describe('shapeTiles (whitelist)', () => {
  it('keeps only id, name, role, color, icon and drops everything else the DB might add', () => {
    const tiles = shapeTiles([
      {
        id: PROFILE,
        name: 'Abebe Worku',
        role: 'Kitchen',
        color: '#f97316',
        icon: 'chef-hat',
        username: 'abebe',
        email: 'a@b.invalid',
        permissions: ['x'],
        pin_hash: '$2a$',
      },
    ])
    expect(tiles).toEqual([
      { id: PROFILE, name: 'Abebe Worku', role: 'Kitchen', color: '#f97316', icon: 'chef-hat' },
    ])
    expect(JSON.stringify(tiles)).not.toMatch(/username|email|permission|pin_hash/)
  })
  it('re-validates colour / icon and skips malformed rows', () => {
    expect(shapeTiles([{ id: PROFILE, name: 'A', role: 'R', color: 'red', icon: '<script>' }])).toEqual([
      { id: PROFILE, name: 'A', role: 'R', color: null, icon: null },
    ])
    expect(
      shapeTiles([{ id: 'nope', name: 'A', role: 'R' }, null, 5, { id: PROFILE, name: 1, role: 'R' }]),
    ).toEqual([])
  })
  it('null for a non-array (the DB answers NULL for an invalid kiosk)', () => {
    expect(shapeTiles(null)).toBeNull()
    expect(shapeTiles({})).toBeNull()
    expect(shapeTiles([])).toEqual([])
  })
})

describe('responses', () => {
  it('every response is no-store and noindex', () => {
    for (const r of [
      shapeFailure('invalid_kiosk'),
      shapeFailure('invalid_request'),
      shapeFailure('rate_limited', 5),
      shapeFailure('server_error'),
      shapeSuccess({ staff: [], pin_pad_idle_seconds: 60 }),
    ]) {
      expect(r.headers['Cache-Control']).toBe('no-store')
      expect(r.headers['X-Robots-Tag']).toBe('noindex, nofollow')
    }
    expect(PRIVATE_HEADERS['Cache-Control']).toBe('no-store')
  })
  it('unknown / revoked / mismatch / wrong origin are one identical 401', () => {
    expect(shapeFailure('forbidden_origin')).toEqual(shapeFailure('invalid_kiosk'))
    expect(shapeFailure('invalid_kiosk')).toMatchObject({ status: 401, body: { error: 'invalid_kiosk' } })
  })
  it('success carries only the staff array and the PIN-pad idle timer', () => {
    expect(shapeSuccess({ staff: [], pin_pad_idle_seconds: 90 }).body).toEqual({
      staff: [],
      pin_pad_idle_seconds: 90,
    })
    expect(Object.keys(shapeSuccess({ staff: [], pin_pad_idle_seconds: 90 }).body)).toEqual([
      'staff',
      'pin_pad_idle_seconds',
    ])
  })
  it('success re-normalises the timer (defence in depth)', () => {
    expect(shapeSuccess({ staff: [], pin_pad_idle_seconds: 5 }).body).toEqual({
      staff: [],
      pin_pad_idle_seconds: 60,
    })
  })
})

describe('PIN-pad idle timer (per tenant, migration 0025)', () => {
  it('bounds and default mirror the database CHECK and column default', () => {
    expect([PIN_PAD_IDLE_MIN_SECONDS, PIN_PAD_IDLE_DEFAULT_SECONDS, PIN_PAD_IDLE_MAX_SECONDS]).toEqual([
      15, 60, 300,
    ])
  })
  it.each([15, 16, 60, 75, 299, 300])('keeps an in-range integer (%j)', (v) => {
    expect(normalizePinPadIdleSeconds(v)).toBe(v)
  })
  it.each([
    14,
    301,
    0,
    -1,
    15.5,
    59.999,
    Number.NaN,
    Infinity,
    -Infinity,
    '60',
    '90',
    null,
    undefined,
    true,
    {},
    [],
    1e9,
  ])('drops an out-of-range or non-integer value to the default (%j)', (v) => {
    expect(normalizePinPadIdleSeconds(v)).toBe(60)
  })
})

describe('shapeRoster (fn_kiosk_terminal_bootstrap answer)', () => {
  const tile = { id: PROFILE, name: 'Abebe Worku', role: 'Kitchen', color: '#ea580c', icon: 'chef-hat' }
  it('accepts {staff, pin_pad_idle_seconds}', () => {
    expect(shapeRoster({ staff: [tile], pin_pad_idle_seconds: 120 })).toEqual({
      staff: [tile],
      pin_pad_idle_seconds: 120,
    })
  })
  it('defaults a missing or invalid timer instead of failing the terminal', () => {
    expect(shapeRoster({ staff: [tile] })).toEqual({ staff: [tile], pin_pad_idle_seconds: 60 })
    expect(shapeRoster({ staff: [], pin_pad_idle_seconds: 9999 })).toEqual({
      staff: [],
      pin_pad_idle_seconds: 60,
    })
    expect(shapeRoster({ staff: [], pin_pad_idle_seconds: '45' })).toEqual({
      staff: [],
      pin_pad_idle_seconds: 60,
    })
  })
  it('drops every other field (tiles through the whitelist too)', () => {
    const r = shapeRoster({
      staff: [{ ...tile, username: 'abebe', pin_hash: 'x' }],
      pin_pad_idle_seconds: 30,
      restaurant_id: PROFILE,
      extra: 1,
    })
    expect(r).toEqual({ staff: [tile], pin_pad_idle_seconds: 30 })
    expect(Object.keys(r ?? {})).toEqual(['staff', 'pin_pad_idle_seconds'])
  })
  it.each([
    null,
    undefined,
    [],
    [tile],
    'x',
    5,
    {},
    { staff: null },
    { staff: {} },
    { pin_pad_idle_seconds: 60 },
  ])('is null (=> 401 invalid_kiosk) unless staff is an array (%j)', (v) => {
    expect(shapeRoster(v)).toBeNull()
  })
})

describe('pin-login tile path parsing', () => {
  const tile = { restaurant_slug: 'central-cafe', kiosk_token: TOKEN, profile_id: PROFILE, pin: '4829' }
  it('accepts exactly {restaurant_slug, kiosk_token, profile_id, pin} with a 4-digit PIN', () => {
    const r = parsePinLoginBody(body(tile))
    expect(r).toEqual({ ok: true, value: tile })
    if (r.ok) expect(isTileLogin(r.value)).toBe(true)
  })
  it('the username path is unchanged (and not a tile)', () => {
    const r = parsePinLoginBody(body({ restaurant_slug: 'central-cafe', username: 'hanna', pin: '480516' }))
    expect(r.ok).toBe(true)
    if (r.ok) expect(isTileLogin(r.value)).toBe(false)
  })
  it.each([
    ['a 6-digit PIN from a tile', { ...tile, pin: '480516' }],
    ['username riding along', { ...tile, username: 'hanna' }],
    ['missing profile_id', { restaurant_slug: 'central-cafe', kiosk_token: TOKEN, pin: '4829' }],
    [
      'profile_id without a token (username path may not take an id)',
      { restaurant_slug: 'central-cafe', profile_id: PROFILE, pin: '4829' },
    ],
    ['bad token', { ...tile, kiosk_token: 'x' }],
    ['bad profile id', { ...tile, profile_id: 'nope' }],
  ])('rejects %s', (_n, o) => expect(parsePinLoginBody(body(o)).ok).toBe(false))
  it('throttles tile attempts per (tenant, profile)', () => {
    const l = createPinLoginLimiters(() => 0)
    const r = parsePinLoginBody(body(tile))
    if (!r.ok) throw new Error('parse')
    const results = Array.from({ length: 8 }, () => checkRateLimits(l, '1.2.3.4', r.value).allowed)
    expect(results.filter(Boolean).length).toBe(6)
  })
})
