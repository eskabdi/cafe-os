import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanDisplayText, fetchStaffRoster, parseRoster } from './staff-roster'

const h = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./client', () => ({ supabase: { functions: { invoke: h.invoke } } }))

const req = { restaurant_slug: 'demo-cafe', kiosk_token: 'ab'.repeat(32) }
const ID = '11111111-1111-4111-8111-111111111111'

describe('parseRoster', () => {
  it('keeps valid rows and nulls out bad presentation', () => {
    const staff = parseRoster({
      staff: [
        { id: ID, name: 'Abebe Kebede', role: 'Runner', color: '#123abc', icon: 'rocket' },
        { id: ID, name: 'Sara', role: 'Waiter', color: 'red; background:url(x)', icon: '../../x' },
        { id: 'not-a-uuid', name: 'X', role: 'Y', color: null, icon: null },
        { id: ID, name: '', role: 'Y', color: null, icon: null },
        'junk',
      ],
    })
    expect(staff).toEqual([
      { id: ID, name: 'Abebe Kebede', role: 'Runner', color: '#123abc', icon: 'rocket' },
      { id: ID, name: 'Sara', role: 'Waiter', color: null, icon: null },
    ])
  })

  it('rejects a non-roster payload', () => {
    expect(parseRoster(null)).toBeNull()
    expect(parseRoster({})).toBeNull()
    expect(parseRoster({ staff: 'x' })).toBeNull()
  })
})

describe('display text sanitising', () => {
  it('strips control, bidi override and zero-width characters and collapses whitespace', () => {
    expect(cleanDisplayText('  Ab\u202Eebe\u0000 \n\t Ke\u200Bbede\u2066 ')).toBe('Ab ebe Ke bede')
    expect(cleanDisplayText('Wai\u0007ter')).toBe('Wai ter')
    expect(cleanDisplayText('Plain Name')).toBe('Plain Name')
  })

  it('applies to roster rows and drops a name that is only invisible characters', () => {
    const staff = parseRoster({
      staff: [
        { id: ID, name: 'Dawit\u202E  Haile', role: 'Run\u0000ner\u200F', color: null, icon: null },
        { id: ID, name: '\u202E\u200B  ', role: 'X', color: null, icon: null },
      ],
    })
    expect(staff).toEqual([{ id: ID, name: 'Dawit Haile', role: 'Run ner', color: null, icon: null }])
  })
})

describe('fetchStaffRoster', () => {
  beforeEach(() => h.invoke.mockReset())

  it('posts exactly slug + token and returns tiles', async () => {
    h.invoke.mockResolvedValue({ data: { staff: [{ id: ID, name: 'A B', role: 'R', color: null, icon: null }] }, error: null })
    const res = await fetchStaffRoster(req)
    expect(res).toEqual({ ok: true, staff: [{ id: ID, name: 'A B', role: 'R', color: null, icon: null }] })
    expect(h.invoke).toHaveBeenCalledWith('staff-roster', { body: req })
  })

  it.each([
    [401, 'invalid_kiosk'],
    [429, 'rate_limited'],
    [400, 'server_error'],
    [503, 'server_error'],
  ] as const)('maps HTTP %s to %s', async (status, reason) => {
    h.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('{}', { status })) })
    await expect(fetchStaffRoster(req)).resolves.toEqual({ ok: false, reason })
  })

  it('maps network failure and a malformed body', async () => {
    h.invoke.mockResolvedValue({ data: null, error: new FunctionsFetchError(new Error('offline')) })
    await expect(fetchStaffRoster(req)).resolves.toEqual({ ok: false, reason: 'network' })
    h.invoke.mockResolvedValue({ data: { nope: 1 }, error: null })
    await expect(fetchStaffRoster(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
  })
})
