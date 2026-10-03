import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pinLogin } from './pin-login'
import { failureFromStatus } from './pin-login-errors'

const h = vi.hoisted(() => ({ invoke: vi.fn(), setSession: vi.fn() }))
vi.mock('./client', () => ({ supabase: { functions: { invoke: h.invoke }, auth: { setSession: h.setSession } } }))

const req = { restaurant_slug: 'demo-cafe', username: 'abebe', pin: '1234' }

describe('failureFromStatus', () => {
  it('maps statuses to safe categories', () => {
    expect(failureFromStatus(401)).toBe('invalid_credentials')
    expect(failureFromStatus(429)).toBe('rate_limited')
    expect(failureFromStatus(400)).toBe('invalid_request')
    expect(failureFromStatus(413)).toBe('invalid_request')
    expect(failureFromStatus(503)).toBe('server_error')
    expect(failureFromStatus(500)).toBe('server_error')
  })
})

describe('pinLogin', () => {
  beforeEach(() => {
    h.invoke.mockReset()
    h.setSession.mockReset()
  })

  it('installs the returned session on success', async () => {
    h.invoke.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 3600 }, error: null })
    h.setSession.mockResolvedValue({ error: null })
    await expect(pinLogin(req)).resolves.toEqual({ ok: true })
    expect(h.invoke).toHaveBeenCalledWith('pin-login', { body: req })
    expect(h.setSession).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r' })
  })

  it('maps HTTP errors by status and never installs a session', async () => {
    for (const [status, reason] of [
      [401, 'invalid_credentials'],
      [429, 'rate_limited'],
      [400, 'invalid_request'],
      [503, 'server_error'],
    ] as const) {
      h.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('{}', { status })) })
      await expect(pinLogin(req)).resolves.toEqual({ ok: false, reason })
    }
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('maps network failures', async () => {
    h.invoke.mockResolvedValue({ data: null, error: new FunctionsFetchError(new Error('offline')) })
    await expect(pinLogin(req)).resolves.toEqual({ ok: false, reason: 'network' })
  })

  it('treats a malformed success body as a server error', async () => {
    h.invoke.mockResolvedValue({ data: { access_token: 'a' }, error: null })
    await expect(pinLogin(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
    expect(h.setSession).not.toHaveBeenCalled()
  })

  it('treats setSession failure as a server error', async () => {
    h.invoke.mockResolvedValue({ data: { access_token: 'a', refresh_token: 'r', expires_in: 5 }, error: null })
    h.setSession.mockResolvedValue({ error: new Error('bad jwt') })
    await expect(pinLogin(req)).resolves.toEqual({ ok: false, reason: 'server_error' })
  })
})
