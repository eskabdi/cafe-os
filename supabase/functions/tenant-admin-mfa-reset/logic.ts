// Pure logic for the tenant-admin-mfa-reset Edge Function: body parsing, RPC result validation, error mapping, response shaping.
// No Deno-only imports and no I/O, so Vitest can import it. Never log or echo the reason, a factor id or a token.

/** restaurant_id + profile_id + a reason of up to 500 characters (Amharic: up to 3 bytes each) plus JSON overhead. */
export const MAX_BODY_BYTES = 2048
export const REASON_MIN = 3
export const REASON_MAX = 500
/** GoTrue allows few factors per user; anything above this is not a real prepare answer. */
export const MAX_FACTORS = 20
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface MfaResetInput {
  restaurant_id: string
  profile_id: string
  reason: string
}
export type ParseResult = { ok: true; value: MfaResetInput } | { ok: false; error: 'invalid_request' }

/**
 * Exactly { restaurant_id, profile_id, reason }. The reason is trimmed with String.prototype.trim (every Unicode white space) and
 * must be 3..500 code points here. This is a PRE-CHECK only: SQL fn_platform_reason is authoritative and trims with btrim (spaces
 * only), so a value this check accepts can still be refused there (invalid_input -> 400) but never the other way round in practice.
 */
export function parseMfaResetBody(text: string): ParseResult {
  const fail: ParseResult = { ok: false, error: 'invalid_request' }
  if (text.length === 0 || new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return fail
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== 3 || !('restaurant_id' in obj) || !('profile_id' in obj) || !('reason' in obj)) return fail
  const { restaurant_id, profile_id, reason } = obj
  if (typeof restaurant_id !== 'string' || !UUID_RE.test(restaurant_id)) return fail
  if (typeof profile_id !== 'string' || !UUID_RE.test(profile_id)) return fail
  if (typeof reason !== 'string') return fail
  const trimmed = reason.trim()
  const chars = [...trimmed].length
  if (chars < REASON_MIN || chars > REASON_MAX) return fail
  return { ok: true, value: { restaurant_id: restaurant_id.toLowerCase(), profile_id: profile_id.toLowerCase(), reason: trimmed } }
}

/**
 * {reset_id, profile_id, user_id, factor_ids} from fn_platform_prepare_mfa_reset. The ids must be the requested profile (a profile id
 * IS its auth user id); reset_id a uuid; factor_ids a duplicate-free list of uuids, EMPTY when the database lets the Super Admin
 * finish a half-done reset (the factors were already deleted). Anything else fails closed.
 */
export function interpretPrepare(
  data: unknown,
  profileId: string,
): { resetId: string; userId: string; factorIds: string[] } | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.profile_id !== profileId || d.user_id !== profileId) return null
  if (typeof d.reset_id !== 'string' || !UUID_RE.test(d.reset_id)) return null
  if (!Array.isArray(d.factor_ids) || d.factor_ids.length > MAX_FACTORS) return null
  const ids: string[] = []
  for (const id of d.factor_ids) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) return null
    const lower = id.toLowerCase()
    if (ids.includes(lower)) return null
    ids.push(lower)
  }
  return { resetId: d.reset_id.toLowerCase(), userId: profileId, factorIds: ids }
}

export interface CompleteResult {
  sessionsRevoked: number | null
  devicesRevoked: number
}
export type CompleteOutcome = ({ ok: true } & CompleteResult) | { ok: false; kind: 'forbidden' | 'not_found' }

/**
 * The completion step's answer: {profile_id, sessions_revoked (null when the DB role may not touch auth.sessions), devices_revoked},
 * or {profile_id, refused: permission_denied | not_found} when the requester / target no longer qualifies after the factors were
 * already deleted (returned, not raised, so the database keeps its tenant_admin.mfa_reset_incomplete audit row).
 */
export function interpretComplete(data: unknown, profileId: string): CompleteOutcome | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.profile_id !== profileId) return null
  if ('refused' in d) {
    if (d.refused === 'permission_denied') return { ok: false, kind: 'forbidden' }
    if (d.refused === 'not_found') return { ok: false, kind: 'not_found' }
    return null
  }
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  if (!count(d.devices_revoked)) return null
  if (d.sessions_revoked !== null && !count(d.sessions_revoked)) return null
  return { ok: true, sessionsRevoked: d.sessions_revoked, devicesRevoked: d.devices_revoked }
}

/** Random bytes behind the rotated password (256 bits). */
export const ROTATION_BYTES = 32
/**
 * The throw-away password the reset sets (nobody ever learns it: never logged, never returned). base64url of 32 random bytes plus a
 * fixed 'aA1!' tail so that any GoTrue password-strength policy (lower, upper, digit, symbol) accepts it; the entropy is the random
 * part. `random` is injectable for tests (default: Web Crypto).
 */
export function rotationPassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const bytes = random(ROTATION_BYTES)
  if (bytes.length !== ROTATION_BYTES) throw new Error('rotation_entropy')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + 'aA1!'
}

export type FailureKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'mfa_required'
  | 'step_up_required'
  | 'not_found'
  | 'no_factor'
  | 'reset_expired'
  | 'rate_limited'
  | 'payload_too_large'
  | 'method_not_allowed'
  | 'forbidden_origin'
  | 'server_error'

/** Maps the SQL error of the caller-scoped prepare step (message = code, detail = sub-code). */
export function mapRpcError(message: unknown, detail?: unknown): FailureKind {
  switch (typeof message === 'string' ? message : '') {
    case 'mfa_required':
      return 'mfa_required'
    case 'step_up_required':
      return 'step_up_required'
    case 'permission_denied':
    case 'not_authenticated':
      return 'forbidden'
    case 'not_found':
      return 'not_found'
    case 'invalid_state':
      return detail === 'no_factor' ? 'no_factor' : 'server_error'
    case 'invalid_input':
      return 'invalid_request'
    default:
      return 'server_error'
  }
}

/**
 * Maps the SQL error of the service-role completion step. reset_expired / reset_superseded / reset_completed: the reset row can no
 * longer be used (the Super Admin starts again); factors_remain and anything else: server_error (nothing was revoked, retry).
 */
export function mapCompleteError(message: unknown, detail?: unknown): FailureKind {
  switch (typeof message === 'string' ? message : '') {
    case 'permission_denied':
      return 'forbidden'
    case 'not_found':
      return 'not_found'
    case 'invalid_state':
      return detail === 'reset_expired' || detail === 'reset_superseded' || detail === 'reset_completed'
        ? 'reset_expired'
        : 'server_error'
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
    case 'unauthorized':
      return json(401, 'unauthorized')
    case 'forbidden':
    case 'forbidden_origin':
      return json(403, 'forbidden')
    case 'mfa_required':
      return json(403, 'mfa_required')
    case 'step_up_required':
      return json(403, 'step_up_required')
    case 'not_found':
      return json(404, 'not_found')
    case 'no_factor':
      return json(409, 'no_factor')
    case 'reset_expired':
      return json(409, 'reset_expired')
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

/**
 * factorsRemoved: factors GoTrue deleted in this call (an unverified leftover that failed to delete does not block the reset).
 * password_rotated is always true on success (the function refuses to complete without rotating); recoverySent: whether GoTrue
 * accepted the password-recovery e-mail to the Tenant Admin's registered address.
 */
export function shapeSuccess(
  profileId: string,
  result: CompleteResult,
  factorsRemoved: number,
  recoverySent: boolean,
): ShapedResponse {
  return {
    status: 200,
    body: {
      profile_id: profileId,
      mfa_reset: true,
      factors_removed: factorsRemoved,
      sessions_revoked: result.sessionsRevoked,
      devices_revoked: result.devicesRevoked,
      password_rotated: true,
      recovery_sent: recoverySent,
    },
    headers: { ...NO_STORE },
  }
}
