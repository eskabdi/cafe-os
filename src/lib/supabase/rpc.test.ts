import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSessionContext, getSessionTimers, resetSessionTimers, RpcError, updateSessionTimers } from './rpc'

const h = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('./client', () => ({ supabase: { rpc: h.rpc } }))

const timers = { idle_warning_seconds: 20, signout_seconds: 60, pin_pad_idle_seconds: 90 }

beforeEach(() => {
  h.rpc.mockReset()
})

describe('session timer RPCs', () => {
  it('call the three functions with the documented argument names', async () => {
    h.rpc.mockResolvedValue({ data: timers, error: null })
    await expect(getSessionTimers()).resolves.toEqual(timers)
    expect(h.rpc).toHaveBeenLastCalledWith('fn_get_session_timers', undefined)
    await updateSessionTimers(timers)
    expect(h.rpc).toHaveBeenLastCalledWith('fn_update_session_timers', {
      p_idle_warning_seconds: 20,
      p_signout_seconds: 60,
      p_pin_pad_idle_seconds: 90,
    })
    await resetSessionTimers()
    expect(h.rpc).toHaveBeenLastCalledWith('fn_reset_session_timers', undefined)
  })

  it('rejects a malformed response', async () => {
    h.rpc.mockResolvedValue({ data: { idle_warning_seconds: '15' }, error: null })
    await expect(getSessionTimers()).rejects.toThrow()
  })

  it('surfaces invalid_input with the field name as detail, and drops unsafe details', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'invalid_input', details: 'signout_seconds' } })
    const err = await updateSessionTimers(timers).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect(err).toMatchObject({ code: 'invalid_input', detail: 'signout_seconds' })

    h.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'invalid_input', details: 'Failing row contains (secret, ...)' },
    })
    expect(await updateSessionTimers(timers).catch((e: unknown) => e)).toMatchObject({ code: 'invalid_input', detail: undefined })

    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'relation "x" does not exist', details: null } })
    expect(await getSessionTimers().catch((e: unknown) => e)).toMatchObject({ code: 'rpc_failed' })
  })
})

describe('session context', () => {
  const base = {
    user: { id: 'u', first_name: 'A', username: 'a' },
    permissions: [],
    station_ids: [],
  }

  it('reads session_timers and tolerates a malformed value without failing sign-in', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...base, session_timers: timers }, error: null })
    expect((await getSessionContext())?.session_timers).toEqual(timers)
    h.rpc.mockResolvedValueOnce({ data: { ...base, session_timers: 'oops' }, error: null })
    const ctx = await getSessionContext()
    expect(ctx?.user?.id).toBe('u')
    expect(ctx?.session_timers).toBeUndefined()
  })

  it('fails loudly on an unknown pin_change_status instead of guessing', async () => {
    h.rpc.mockResolvedValueOnce({ data: { ...base, pin_change_status: 'mystery' }, error: null })
    await expect(getSessionContext()).rejects.toThrow()
  })
})
