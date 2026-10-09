import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => ({ callRpc: vi.fn() }))
vi.mock('./rpc', () => rpc)
const session = vi.hoisted(() => ({ token: null as string | null }))
vi.mock('./client', () => ({
  supabase: { auth: { getSession: () => Promise.resolve({ data: { session: session.token ? { access_token: session.token } : null } }) } },
}))

import { forgetDeviceToken, isAttestedSession, readDeviceToken, sessionIdOf, writeDeviceToken } from '@/lib/utils/device-token'
import { checkThisDevice, deviceLabel, trustThisDevice } from './trusted-devices'

const SID = '11111111-1111-4111-8111-111111111111'
const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.y`
const TOKEN = 'a'.repeat(64)

describe('trusted devices (client)', () => {
  beforeEach(() => {
    forgetDeviceToken('u1')
    forgetDeviceToken('u2')
    rpc.callRpc.mockReset()
    session.token = jwt({ session_id: SID })
  })

  it('labels the device from the user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/120 Safari/537')).toBe('Chrome on Windows')
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17) AppleWebKit Version/17 Safari/604')).toBe('Safari on iOS')
    expect(deviceLabel('')).toBe('Browser on unknown system')
  })

  it('stores only well-formed tokens, per user', () => {
    writeDeviceToken('u1', 'not-a-token')
    expect(readDeviceToken('u1')).toBeNull()
    writeDeviceToken('u1', TOKEN)
    expect(readDeviceToken('u1')).toBe(TOKEN)
    expect(readDeviceToken('u2')).toBeNull()
  })

  it('trust: stores the returned token and marks the session attested', async () => {
    rpc.callRpc.mockResolvedValue({ device_id: SID, token: TOKEN, expires_at: '2026-11-08T00:00:00Z' })
    await trustThisDevice('u1')
    expect(rpc.callRpc).toHaveBeenCalledWith('fn_trust_device', { p_label: expect.any(String) })
    expect(readDeviceToken('u1')).toBe(TOKEN)
    expect(isAttestedSession(session.token)).toBe(true)
  })

  it('check: no token, no call', async () => {
    expect(await checkThisDevice('u1')).toBe(false)
    expect(rpc.callRpc).not.toHaveBeenCalled()
  })

  it('check: a token the server refuses is forgotten', async () => {
    writeDeviceToken('u1', TOKEN)
    rpc.callRpc.mockResolvedValue({ trusted: false })
    expect(await checkThisDevice('u1')).toBe(false)
    expect(readDeviceToken('u1')).toBeNull()
  })

  it('check: trusted attests this session (UX hint only)', async () => {
    writeDeviceToken('u1', TOKEN)
    rpc.callRpc.mockResolvedValue({ trusted: true, expires_at: '2026-11-08T00:00:00Z' })
    expect(await checkThisDevice('u1')).toBe(true)
    expect(isAttestedSession(session.token)).toBe(true)
    expect(isAttestedSession(jwt({ session_id: '22222222-2222-4222-8222-222222222222' }))).toBe(false)
  })

  it('check: a failing call is simply "not trusted"', async () => {
    writeDeviceToken('u1', TOKEN)
    rpc.callRpc.mockRejectedValue(new Error('network'))
    expect(await checkThisDevice('u1')).toBe(false)
    expect(readDeviceToken('u1')).toBe(TOKEN)
  })

  it('reads the session id claim defensively', () => {
    expect(sessionIdOf(jwt({ session_id: SID }))).toBe(SID)
    expect(sessionIdOf(jwt({ session_id: 'x' }))).toBeNull()
    expect(sessionIdOf('garbage')).toBeNull()
    expect(sessionIdOf(null)).toBeNull()
  })
})
