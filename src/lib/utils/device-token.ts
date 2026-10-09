// Browser-side storage for the trusted-device token (0032). Allow-listed in
// scripts/check-forbidden-patterns.mjs like kiosk-token.ts: a per-user device credential, never domain data. Every access is
// wrapped: private mode or blocked storage simply means the device is not remembered (the code is asked again).

const TOKEN_RE = /^[0-9a-f]{64}$/
const KEY_PREFIX = 'cafeos.trusted-device.v1.'

/** The `session_id` claim of an access token (null when unreadable). */
export function sessionIdOf(accessToken: string | null | undefined): string | null {
  const part = accessToken?.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const payload: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    const sid = typeof payload === 'object' && payload !== null ? (payload as { session_id?: unknown }).session_id : null
    return typeof sid === 'string' && /^[0-9a-f-]{36}$/i.test(sid) ? sid : null
  } catch {
    return null
  }
}

function storageKey(userId: string): string {
  return KEY_PREFIX + userId
}

/** The stored device token of this browser for `userId` (null when absent, malformed or storage is unavailable). */
export function readDeviceToken(userId: string): string | null {
  try {
    const v = globalThis.localStorage?.getItem(storageKey(userId)) ?? null
    return v && TOKEN_RE.test(v) ? v : null
  } catch {
    return null
  }
}

export function writeDeviceToken(userId: string, token: string): void {
  if (!TOKEN_RE.test(token)) return
  try {
    globalThis.localStorage?.setItem(storageKey(userId), token)
  } catch {
    // private mode / blocked storage: the device simply is not remembered (the code is asked next time)
  }
}

export function forgetDeviceToken(userId: string): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(userId))
  } catch {
    // nothing to forget
  }
}

