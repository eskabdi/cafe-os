// Pure logic for the staff-pin-reset Edge Function: body parsing (PIN policy), RPC result validation, error mapping,
// response shaping. No Deno-only imports and no I/O, so Vitest can import it. Never log or echo a PIN, a digest or the pepper.
import { PIN_RE, isWeakPin, pinLengthForRole } from '../_shared/pin.ts'

export const MAX_BODY_BYTES = 256
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface PinResetInput {
  profile_id: string
  pin: string
}
export type ParseResult = { ok: true; value: PinResetInput } | { ok: false; error: 'invalid_request' | 'weak_pin' }

/** Exactly { profile_id, pin }. The PIN must be 4 or 6 digits and not weak; the role-specific length is checked after step 1. */
export function parsePinResetBody(text: string): ParseResult {
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
  if (keys.length !== 2 || !('profile_id' in obj) || !('pin' in obj)) return fail
  if (typeof obj.profile_id !== 'string' || !UUID_RE.test(obj.profile_id) || typeof obj.pin !== 'string') return fail
  if (!PIN_RE.test(obj.pin)) return fail
  if (isWeakPin(obj.pin)) return { ok: false, error: 'weak_pin' }
  return { ok: true, value: { profile_id: obj.profile_id.toLowerCase(), pin: obj.pin } }
}

/**
 * {profile_id, role_name, pin_length} from fn_prepare_pin_reset. The two length sources must agree (SQL fn_pin_length_for_role and
 * the TypeScript pinLengthForRole of the server-side role name); any disagreement fails closed.
 */
export function interpretPrepare(data: unknown, profileId: string): { pinLength: 4 | 6 } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.profile_id !== profileId || typeof d.role_name !== 'string' || d.role_name.length === 0 || d.role_name.length > 60) return null
  const ts = pinLengthForRole(d.role_name)
  if (d.pin_length !== ts) return null
  return { pinLength: ts }
}

export type FailureKind =
  | 'invalid_request'
  | 'weak_pin'
  | 'invalid_pin_length'
  | 'unauthorized'
  | 'forbidden'
  | 'mfa_required'
  | 'not_found'
  | 'pin_not_allowed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'method_not_allowed'
  | 'forbidden_origin'
  | 'server_error'

export function mapRpcError(message: unknown): FailureKind {
  switch (typeof message === 'string' ? message : '') {
    case 'mfa_required':
      return 'mfa_required'
    case 'permission_denied':
    case 'permission_escalation':
    case 'not_authenticated':
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'forbidden'
    case 'not_found':
      return 'not_found'
    case 'pin_not_allowed':
    case 'invalid_state':
      return 'pin_not_allowed'
    case 'invalid_input':
      return 'invalid_request'
    default:
      return 'server_error'
  }
}

export interface ShapedResponse {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

export function shapeFailure(kind: FailureKind, retryAfterSec?: number): ShapedResponse {
  const json = (status: number, error: string, extra: Record<string, string> = {}): ShapedResponse => ({
    status,
    body: { error },
    headers: { ...NO_STORE, ...extra },
  })
  switch (kind) {
    case 'invalid_request':
      return json(400, 'invalid_request')
    case 'weak_pin':
      return json(400, 'weak_pin')
    case 'invalid_pin_length':
      return json(400, 'invalid_pin_length')
    case 'unauthorized':
      return json(401, 'unauthorized')
    case 'forbidden':
    case 'forbidden_origin':
      return json(403, 'forbidden')
    case 'mfa_required':
      return json(403, 'mfa_required')
    case 'not_found':
      return json(404, 'not_found')
    case 'pin_not_allowed':
      return json(409, 'pin_not_allowed')
    case 'payload_too_large':
      return json(413, 'invalid_request')
    case 'method_not_allowed':
      return json(405, 'invalid_request', { Allow: 'POST, OPTIONS' })
    case 'rate_limited':
      return json(429, 'try_later', { 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec ?? 30))) })
    case 'server_error':
      return json(503, 'server_error')
  }
}

export function shapeSuccess(profileId: string): ShapedResponse {
  return { status: 200, body: { profile_id: profileId, pin_reset: true }, headers: { ...NO_STORE } }
}
