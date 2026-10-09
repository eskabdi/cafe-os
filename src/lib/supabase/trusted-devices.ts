import { z } from 'zod'
import { forgetDeviceToken, markAttested, readDeviceToken, writeDeviceToken } from '@/lib/utils/device-token'
import { supabase } from './client'
import { callRpc } from './rpc'

export { forgetDeviceToken, isAttestedSession, readDeviceToken, sessionIdOf } from '@/lib/utils/device-token'

// Trusted devices (migration 0032, owner decision 2026-10-09). The TOTP code is asked on the first sign-in from a new device;
// the device then stays trusted for 30 days. The server stores only a hash of the device token and decides everything:
// fn_check_trusted_device attests THIS session, and every portal gate re-checks that attestation. The token kept here is a
// per-user bearer secret for this browser (useless without that user's password session); it is not domain data.

const TOKEN_RE = /^[0-9a-f]{64}$/

const deviceSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(['platform', 'tenant']),
  label: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  expires_at: z.string(),
  current: z.boolean().optional(),
})
export type TrustedDevice = z.infer<typeof deviceSchema>

export const trustedDeviceKeys = {
  mine: ['trusted-devices', 'mine'] as const,
  user: (userId: string) => ['trusted-devices', 'user', userId] as const,
}

/** A short, human label for the device list ("Chrome on Windows"). Never sent anywhere else. */
export function deviceLabel(userAgent: string | undefined = globalThis.navigator?.userAgent): string {
  const ua = userAgent ?? ''
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown system'
  return `${browser} on ${os}`
}

const trustSchema = z.object({ device_id: z.string().uuid(), token: z.string().regex(TOKEN_RE), expires_at: z.string() })

/** Right after a TOTP verification (server: a code of the last 10 minutes): trust this browser for 30 days. */
export async function trustThisDevice(userId: string): Promise<void> {
  const r = trustSchema.parse(await callRpc('fn_trust_device', { p_label: deviceLabel() }))
  writeDeviceToken(userId, r.token)
  markAttested((await supabase.auth.getSession()).data.session?.access_token)
}

const checkSchema = z.object({ trusted: z.boolean(), expires_at: z.string().optional() })

/**
 * After a password sign-in: is this browser trusted for `userId`? On true the server has attested the current session, so the
 * portal gates accept it without a TOTP step. A token the server no longer accepts is forgotten.
 */
export async function checkThisDevice(userId: string): Promise<boolean> {
  const token = readDeviceToken(userId)
  if (!token) return false
  try {
    const r = checkSchema.parse(await callRpc('fn_check_trusted_device', { p_token: token }))
    if (!r.trusted) forgetDeviceToken(userId)
    else markAttested((await supabase.auth.getSession()).data.session?.access_token)
    return r.trusted
  } catch {
    return false
  }
}

export async function listMyTrustedDevices(): Promise<TrustedDevice[]> {
  return z.array(deviceSchema).parse(await callRpc('fn_list_my_trusted_devices'))
}

export async function listUserTrustedDevices(userId: string): Promise<TrustedDevice[]> {
  return z.array(deviceSchema).parse(await callRpc('fn_list_user_trusted_devices', { p_user_id: userId }))
}

export async function revokeTrustedDevice(deviceId: string): Promise<{ changed: boolean }> {
  return z.object({ changed: z.boolean() }).parse(await callRpc('fn_revoke_trusted_device', { p_device_id: deviceId }))
}

/** `userId` null = the caller's own devices. */
export async function revokeAllTrustedDevices(userId: string | null): Promise<{ revoked: number }> {
  return z
    .object({ revoked: z.number().int().nonnegative() })
    .parse(await callRpc('fn_revoke_all_trusted_devices', { p_user_id: userId }))
}
