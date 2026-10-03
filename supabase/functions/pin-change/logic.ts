// Pure logic for the pin-change Edge Function: validation, role-based length policy, error mapping, response shaping.
// No Deno-only imports and no I/O, so Vitest can import this file. Never log or echo a PIN, digest or token from here.
import { PIN_RE, isWeakPin, pinLengthForRole } from '../_shared/pin.ts'

export const MAX_BODY_BYTES = 256
export { extractBearer } from '../staff-create/logic.ts'
export { clientIp, createRateLimiter, interpretVerifyResult, remainingDelayMs } from '../pin-login/logic.ts'

const REQUIRED_KEYS = ['current_pin', 'new_pin'] as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PinChangeInput {
  current_pin: string
  new_pin: string
}

export type ParseFailure = 'invalid_request' | 'weak_pin' | 'same_pin'
export type ParseResult = { ok: true; value: PinChangeInput } | { ok: false; error: ParseFailure }

/**
 * Strict parse: exactly {current_pin, new_pin}, both 4 or 6 digit strings (the role-specific length needs the profile and is
 * checked by pinLengthOk after the lookup). The new PIN must not be weak and must differ from the current one. All of this is
 * decided from the request alone, before any database work, so it reveals nothing about the stored PIN.
 */
export function parsePinChangeBody(text: string): ParseResult {
  const fail: ParseResult = { ok: false, error: 'invalid_request' }
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return fail
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== REQUIRED_KEYS.length || !REQUIRED_KEYS.every((k) => keys.includes(k))) return fail
  const { current_pin, new_pin } = obj
  if (typeof current_pin !== 'string' || typeof new_pin !== 'string') return fail
  if (!PIN_RE.test(current_pin) || !PIN_RE.test(new_pin)) return fail
  if (isWeakPin(new_pin)) return { ok: false, error: 'weak_pin' }
  if (new_pin === current_pin) return { ok: false, error: 'same_pin' }
  return { ok: true, value: { current_pin, new_pin } }
}

/** The new PIN must have the length the caller's role requires (4; 6 for the documented Cashier exception, see _shared/pin.ts). */
export function pinLengthOk(newPin: string, roleName: unknown): boolean {
  return typeof roleName === 'string' && roleName.length > 0 && newPin.length === pinLengthForRole(roleName)
}

/** Whether the looked-up profile may change a PIN here at all (same eligibility as PIN login: active non-admin PIN member). */
export function isChangeCandidate(profile: unknown, userId: string): profile is { id: string; restaurant_id: string; role_id: string } {
  if (typeof profile !== 'object' || profile === null) return false
  const p = profile as { id?: unknown; restaurant_id?: unknown; role_id?: unknown; auth_method?: unknown; is_active?: unknown }
  return (
    p.id === userId &&
    typeof p.restaurant_id === 'string' && UUID_RE.test(p.restaurant_id) &&
    typeof p.role_id === 'string' && UUID_RE.test(p.role_id) &&
    p.auth_method === 'pin' &&
    p.is_active === true
  )
}

export type FailureKind =
  | 'invalid_request' | 'weak_pin' | 'same_pin' | 'invalid_pin_length' | 'unauthorized' | 'invalid_credentials'
  | 'rate_limited' | 'payload_too_large' | 'method_not_allowed' | 'forbidden_origin' | 'server_error'

export interface ShapedResponse {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

/**
 * One fixed body per failure kind. A wrong current PIN, a locked account and an ineligible account (admin, inactive,
 * unknown profile) all answer invalid_credentials 401 (same body), exactly like pin-login.
 */
export function shapeFailure(kind: FailureKind, retryAfterSec?: number): ShapedResponse {
  switch (kind) {
    case 'invalid_request':
      return { status: 400, body: { error: 'invalid_request' }, headers: { ...NO_STORE } }
    case 'weak_pin':
      return { status: 400, body: { error: 'weak_pin' }, headers: { ...NO_STORE } }
    case 'same_pin':
      return { status: 400, body: { error: 'same_pin' }, headers: { ...NO_STORE } }
    case 'invalid_pin_length':
      return { status: 400, body: { error: 'invalid_pin_length' }, headers: { ...NO_STORE } }
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' }, headers: { ...NO_STORE } }
    case 'invalid_credentials':
      return { status: 401, body: { error: 'invalid_credentials' }, headers: { ...NO_STORE } }
    case 'forbidden_origin':
      return { status: 403, body: { error: 'forbidden' }, headers: { ...NO_STORE } }
    case 'payload_too_large':
      return { status: 413, body: { error: 'invalid_request' }, headers: { ...NO_STORE } }
    case 'method_not_allowed':
      return { status: 405, body: { error: 'invalid_request' }, headers: { ...NO_STORE, Allow: 'POST, OPTIONS' } }
    case 'rate_limited':
      return {
        status: 429,
        body: { error: 'try_later' },
        headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec ?? 30))) },
      }
    case 'server_error':
      return { status: 503, body: { error: 'server_error' }, headers: { ...NO_STORE } }
  }
}

/** Success whitelist: whether the user's other sessions were revoked is the only thing reported. */
export function shapeSuccess(otherSessionsRevoked: boolean): ShapedResponse {
  return { status: 200, body: { changed: true, other_sessions_revoked: otherSessionsRevoked }, headers: { ...NO_STORE } }
}
