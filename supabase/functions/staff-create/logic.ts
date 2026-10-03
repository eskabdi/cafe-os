// Pure logic for the staff-create Edge Function: input validation, synthetic identity, bearer parsing,
// error mapping and response shaping. No Deno-only imports and no I/O, so Vitest can import this file.
// Never log or echo a PIN, a digest, the pepper, a token or the generated password from here.
import { PIN_RE, isWeakPin } from '../_shared/pin.ts'

export const MAX_BODY_BYTES = 2048
export const STAFF_EMAIL_SUFFIX = '.staff.cafeos.invalid'

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUIRED_KEYS = ['username', 'first_name', 'role_id', 'pin'] as const
const OPTIONAL_KEYS = ['middle_name', 'last_name'] as const

export interface StaffCreateInput {
  username: string
  first_name: string
  middle_name: string | null
  last_name: string | null
  role_id: string
  pin: string
}

export type ParseFailure = 'invalid_request' | 'weak_pin'
export type ParseResult = { ok: true; value: StaffCreateInput } | { ok: false; error: ParseFailure }

function name(v: unknown, required: boolean): string | null | undefined {
  if (v === undefined || v === null) return required ? undefined : null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length === 0) return required ? undefined : null
  return t.length <= 60 ? t : undefined
}

/** Strict parse: exact key set (required + optional), string types, normalized username, PIN policy. */
export function parseStaffCreateBody(text: string): ParseResult {
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
  const allowed = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS])
  if (Object.keys(obj).some((k) => !allowed.has(k))) return fail
  if (!REQUIRED_KEYS.every((k) => k in obj)) return fail
  const { username, role_id, pin } = obj
  if (typeof username !== 'string' || typeof role_id !== 'string' || typeof pin !== 'string') return fail
  const user = username.trim().toLowerCase()
  const first = name(obj.first_name, true)
  const middle = name(obj.middle_name, false)
  const last = name(obj.last_name, false)
  if (!USERNAME_RE.test(user) || !UUID_RE.test(role_id) || !first || middle === undefined || last === undefined) return fail
  if (!PIN_RE.test(pin)) return fail
  if (isWeakPin(pin)) return { ok: false, error: 'weak_pin' }
  return { ok: true, value: { username: user, first_name: first, middle_name: middle, last_name: last, role_id: role_id.toLowerCase(), pin } }
}

/** The synthetic, non-routable identity; the SQL side requires exactly this value (fn_staff_email). */
export function staffEmail(username: string, slug: string): string | null {
  if (!USERNAME_RE.test(username) || !SLUG_RE.test(slug) || slug.includes('--')) return null
  return `${username}@${slug}${STAFF_EMAIL_SUFFIX}`
}

/** 32 random bytes as base64url: an unusable-by-humans password (staff sign in by PIN only). */
export function randomPassword(getRandomValues: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  const bytes = getRandomValues(new Uint8Array(32))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** "Bearer <jwt>" -> jwt (three dot-separated base64url segments), otherwise null. */
export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim())
  return m?.[1] ?? null
}

/** Validates the {slug, username} object returned by fn_prepare_staff_creation. */
export function interpretPrepare(data: unknown, username: string): { slug: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as { slug?: unknown; username?: unknown }
  if (typeof d.slug !== 'string' || !SLUG_RE.test(d.slug) || d.username !== username) return null
  return { slug: d.slug }
}

export type FailureKind =
  | 'invalid_request' | 'weak_pin' | 'unauthorized' | 'forbidden' | 'username_taken' | 'staff_limit_reached'
  | 'rate_limited' | 'payload_too_large' | 'method_not_allowed' | 'forbidden_origin' | 'server_error'

/**
 * Maps the stable machine code PostgREST puts in error.message (rpc-conventions.md) to a generic failure.
 * Only the codes a legitimate staff manager can act on are distinguishable; everything else collapses.
 */
export function mapRpcError(message: unknown): FailureKind {
  switch (typeof message === 'string' ? message : '') {
    case 'permission_denied':
    case 'not_authenticated':
    case 'tenant_suspended':
    case 'tenant_read_only':
    case 'mfa_required':
      return 'forbidden'
    case 'username_taken':
      return 'username_taken'
    case 'staff_limit_reached':
      return 'staff_limit_reached'
    case 'invalid_role':
    case 'permission_escalation':
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
  switch (kind) {
    case 'invalid_request':
      return { status: 400, body: { error: 'invalid_request' }, headers: { ...NO_STORE } }
    case 'weak_pin':
      return { status: 400, body: { error: 'weak_pin' }, headers: { ...NO_STORE } }
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' }, headers: { ...NO_STORE } }
    case 'forbidden':
      return { status: 403, body: { error: 'forbidden' }, headers: { ...NO_STORE } }
    case 'forbidden_origin':
      return { status: 403, body: { error: 'forbidden' }, headers: { ...NO_STORE } }
    case 'username_taken':
      return { status: 409, body: { error: 'username_taken' }, headers: { ...NO_STORE } }
    case 'staff_limit_reached':
      return { status: 409, body: { error: 'staff_limit_reached' }, headers: { ...NO_STORE } }
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

/** Whitelist: the ONLY field that leaves the function on success. Null when the id is malformed. */
export function shapeSuccess(profileId: unknown): ShapedResponse | null {
  if (typeof profileId !== 'string' || !UUID_RE.test(profileId)) return null
  return { status: 201, body: { profile_id: profileId }, headers: { ...NO_STORE } }
}
