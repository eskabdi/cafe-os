import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changePin } from './pin-change'
import {
  DEFAULT_RETRY_AFTER_SEC,
  MAX_RETRY_AFTER_SEC,
  parseRetryAfter,
  pinChangeFailureFrom,
  pinChangeMessage,
  type PinChangeFailure,
} from './pin-change-errors'

const h = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn() }))
vi.mock('./client', () => ({
  supabase: { functions: { invoke: h.invoke }, auth: { getSession: h.getSession } },
}))

const req = { current_pin: '4829', new_pin: '7391' }
const httpError = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new FunctionsHttpError(new Response(JSON.stringify(body), { status, headers }))

beforeEach(() => {
  h.invoke.mockReset()
  h.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'jwt-abc' } } })
})

describe('changePin', () => {
  it('sends exactly the two PINs with an explicit Bearer token and parses the success body', async () => {
    h.invoke.mockResolvedValue({
      data: { changed: true, pending_approval: true, other_sessions_revoked: false, extra: 'ignored' },
      error: null,
    })
    await expect(changePin(req)).resolves.toEqual({ ok: true, pendingApproval: true, otherSessionsRevoked: false })
    const [fn, opts] = h.invoke.mock.calls[0] as [string, { body: unknown; headers: Record<string, string>; signal: unknown }]
    expect(fn).toBe('pin-change')
    expect(opts.body).toEqual({ current_pin: '4829', new_pin: '7391' })
    expect(opts.headers).toEqual({ Authorization: 'Bearer jwt-abc' })
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('answers unauthorized without calling the function when there is no session', async () => {
    h.getSession.mockResolvedValue({ data: { session: null } })
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'unauthorized' })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it('maps every documented error response', async () => {
    const cases: Array<[number, unknown, PinChangeFailure]> = [
      [401, { error: 'invalid_credentials' }, 'invalid_credentials'],
      [401, { error: 'unauthorized' }, 'unauthorized'],
      [401, { error: 'locked' }, 'invalid_credentials'],
      [400, { error: 'weak_pin' }, 'weak_pin'],
      [400, { error: 'same_pin' }, 'same_pin'],
      [400, { error: 'invalid_pin_length' }, 'invalid_pin_length'],
      [400, { error: 'invalid_request' }, 'invalid_request'],
      [400, { error: '<b>other</b>' }, 'invalid_request'],
      [413, { error: 'invalid_request' }, 'invalid_request'],
      [503, { error: 'server_error' }, 'server_error'],
      [500, 'not json', 'server_error'],
    ]
    for (const [status, body, reason] of cases) {
      h.invoke.mockResolvedValueOnce({ data: null, error: httpError(status, body) })
      await expect(changePin(req)).resolves.toEqual({ ok: false, reason })
    }
  })

  it('reads Retry-After on 429', async () => {
    h.invoke.mockResolvedValueOnce({ data: null, error: httpError(429, { error: 'try_later' }, { 'Retry-After': '42' }) })
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'rate_limited', retryAfterSec: 42 })
    h.invoke.mockResolvedValueOnce({ data: null, error: httpError(429, { error: 'try_later' }) })
    await expect(changePin(req)).resolves.toEqual({
      ok: false,
      reason: 'rate_limited',
      retryAfterSec: DEFAULT_RETRY_AFTER_SEC,
    })
  })

  it('maps fetch / relay failures to network and anything unexpected to server_error', async () => {
    h.invoke.mockResolvedValueOnce({ data: null, error: new FunctionsFetchError(new Error('offline')) })
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'network' })
    h.invoke.mockResolvedValueOnce({ data: null, error: new FunctionsRelayError(new Error('relay')) })
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'network' })
    h.invoke.mockResolvedValueOnce({ data: null, error: new Error('odd') })
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
    h.invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
  })

  it('treats a malformed success body as server_error (never guesses "not pending")', async () => {
    for (const data of [{ changed: true }, { changed: true, pending_approval: 'no', other_sessions_revoked: true }, null]) {
      h.invoke.mockResolvedValueOnce({ data, error: null })
      await expect(changePin(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
    }
  })

  it('aborts a stuck request after the timeout and reports network', async () => {
    h.invoke.mockImplementation(
      (_fn: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    )
    await expect(changePin(req, 20)).resolves.toEqual({ ok: false, reason: 'network' })
  })
})

describe('pin-change error helpers', () => {
  it('maps statuses without trusting unknown codes', () => {
    expect(pinChangeFailureFrom(401, undefined)).toBe('invalid_credentials')
    expect(pinChangeFailureFrom(429, 'whatever')).toBe('rate_limited')
    expect(pinChangeFailureFrom(400, 'rate_limited')).toBe('invalid_request')
    expect(pinChangeFailureFrom(403, 'forbidden')).toBe('server_error')
  })

  it('parses Retry-After defensively', () => {
    expect(parseRetryAfter('15')).toBe(15)
    expect(parseRetryAfter(' 7 ')).toBe(7)
    expect(parseRetryAfter('0')).toBe(1)
    expect(parseRetryAfter('999999')).toBe(MAX_RETRY_AFTER_SEC)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(DEFAULT_RETRY_AFTER_SEC)
    expect(parseRetryAfter('-5')).toBe(DEFAULT_RETRY_AFTER_SEC)
    expect(parseRetryAfter(null)).toBe(DEFAULT_RETRY_AFTER_SEC)
  })

  it('never reveals lockout state or attempt counts', () => {
    const reasons: PinChangeFailure[] = [
      'invalid_credentials',
      'unauthorized',
      'weak_pin',
      'same_pin',
      'invalid_pin_length',
      'invalid_request',
      'rate_limited',
      'network',
      'server_error',
    ]
    for (const r of reasons) {
      const m = pinChangeMessage(r, 4, 30)
      expect(m.length).toBeGreaterThan(10)
      expect(m).not.toMatch(/lock|attempts? (left|remaining)|\b[0-9]+ (more )?attempts?\b/i)
    }
    expect(pinChangeMessage('invalid_pin_length', 6)).toContain('6 digits')
    expect(pinChangeMessage('rate_limited', 4, 12)).toContain('12 seconds')
  })
})
