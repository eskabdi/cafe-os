// Pure logic for the tenant-admin-invite Edge Function: body parsing, RPC result validation, error mapping, response
// shaping. No Deno-only imports and no I/O, so Vitest can import this file. Never log an e-mail, a token or an id from here.

export const MAX_BODY_BYTES = 2048

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
// same shape the database enforces (fn_prepare_tenant_admin_invitation); the DB stays authoritative
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i

export type InviteAction =
  | {
      action: 'invite'
      restaurant_id: string | null
      email: string
      first_name: string
      middle_name: string | null
      last_name: string | null
      username: string
    }
  | { action: 'resend'; invitation_id: string }
  | { action: 'revoke'; invitation_id: string }

export type ParseResult = { ok: true; value: InviteAction } | { ok: false; error: 'invalid_request' }

function name(v: unknown, required: boolean): string | null | undefined {
  if (v === undefined || v === null) return required ? undefined : null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length === 0) return required ? undefined : null
  return t.length <= 60 ? t : undefined
}

const exactKeys = (obj: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean => {
  const allowed = new Set([...required, ...optional])
  return Object.keys(obj).every((k) => allowed.has(k)) && required.every((k) => k in obj)
}

/**
 * Strict parse. invite: { action, restaurant_id?, email, first_name, middle_name?, last_name?, username }
 * (restaurant_id is required for a platform caller and must be absent / null for a tenant_admin; the DATABASE decides which
 * caller this is, never this function). resend / revoke: { action, invitation_id }.
 */
export function parseInviteBody(text: string): ParseResult {
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
  if (obj.action === 'resend' || obj.action === 'revoke') {
    if (!exactKeys(obj, ['action', 'invitation_id'], [])) return fail
    if (typeof obj.invitation_id !== 'string' || !UUID_RE.test(obj.invitation_id)) return fail
    return { ok: true, value: { action: obj.action, invitation_id: obj.invitation_id.toLowerCase() } }
  }
  if (obj.action !== 'invite') return fail
  if (!exactKeys(obj, ['action', 'email', 'first_name', 'username'], ['restaurant_id', 'middle_name', 'last_name'])) return fail
  const rid = obj.restaurant_id
  if (rid !== undefined && rid !== null && (typeof rid !== 'string' || !UUID_RE.test(rid))) return fail
  if (typeof obj.email !== 'string' || typeof obj.username !== 'string') return fail
  const email = obj.email.trim().toLowerCase()
  const username = obj.username.trim().toLowerCase()
  const first = name(obj.first_name, true)
  const middle = name(obj.middle_name, false)
  const last = name(obj.last_name, false)
  if (email.length > 254 || !EMAIL_RE.test(email) || email.endsWith('.invalid')) return fail
  if (!USERNAME_RE.test(username) || !first || middle === undefined || last === undefined) return fail
  return {
    ok: true,
    value: {
      action: 'invite',
      restaurant_id: typeof rid === 'string' ? rid.toLowerCase() : null,
      email,
      first_name: first,
      middle_name: middle,
      last_name: last,
      username,
    },
  }
}

/** {invitation_id, email, restaurant_id, expires_at} from fn_prepare_tenant_admin_invitation; null when malformed. */
export function interpretPrepare(data: unknown, expectedEmail: string): { invitationId: string; email: string; expiresAt: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (typeof d.invitation_id !== 'string' || !UUID_RE.test(d.invitation_id)) return null
  if (typeof d.email !== 'string' || d.email !== expectedEmail) return null
  if (typeof d.expires_at !== 'string') return null
  return { invitationId: d.invitation_id, email: d.email, expiresAt: d.expires_at }
}

/** {invitation_id, email} from fn_prepare_tenant_admin_invitation_resend. */
export function interpretResend(data: unknown, invitationId: string): { email: string } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.invitation_id !== invitationId || typeof d.email !== 'string' || !EMAIL_RE.test(d.email)) return null
  return { email: d.email }
}

/** {invitation_id, status, changed} from fn_revoke_tenant_admin_invitation (the caller never learns about the Auth side). */
export function interpretRevoke(data: unknown, invitationId: string): { changed: boolean } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.invitation_id !== invitationId || (d.status !== 'revoked' && d.status !== 'expired') || typeof d.changed !== 'boolean') return null
  return { changed: d.changed }
}

/** {invitation_id, cleanup_user_id} from fn_tenant_admin_invitation_cleanup_user (service role). */
export function interpretCleanup(data: unknown, invitationId: string): { cleanupUserId: string | null } | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.invitation_id !== invitationId) return null
  if (d.cleanup_user_id === null || d.cleanup_user_id === undefined) return { cleanupUserId: null }
  if (typeof d.cleanup_user_id !== 'string' || !UUID_RE.test(d.cleanup_user_id)) return null
  return { cleanupUserId: d.cleanup_user_id }
}

export type DeliveryMode = 'none' | 'invite' | 'replace_unconfirmed' | 'reinvite' | 'magic_link'
export interface DeliveryPlan {
  mode: DeliveryMode
  email: string
  authUserId: string | null
  notBefore: string
}
const MODES: readonly DeliveryMode[] = ['none', 'invite', 'replace_unconfirmed', 'reinvite', 'magic_link']

/** {invitation_id, email, mode, auth_user_id, not_before} from fn_plan_tenant_admin_invitation_delivery (service role). */
export function interpretPlan(data: unknown, invitationId: string): DeliveryPlan | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.invitation_id !== invitationId || typeof d.email !== 'string' || !EMAIL_RE.test(d.email)) return null
  if (typeof d.mode !== 'string' || !(MODES as readonly string[]).includes(d.mode)) return null
  if (typeof d.not_before !== 'string' || Number.isNaN(Date.parse(d.not_before))) return null
  const mode = d.mode as DeliveryMode
  const needsUser = mode === 'replace_unconfirmed' || mode === 'reinvite' || mode === 'magic_link'
  const uid = d.auth_user_id
  if (needsUser) {
    if (typeof uid !== 'string' || !UUID_RE.test(uid)) return null
  } else if (uid !== null && uid !== undefined) {
    return null
  }
  return { mode, email: d.email, authUserId: needsUser ? (uid as string) : null, notBefore: d.not_before }
}

/** inviteUserByEmail must have CREATED the user now (created_at >= not_before): an older account is never adopted. */
export function isFreshlyCreated(user: unknown, expectedEmail: string, notBefore: string): boolean {
  if (typeof user !== 'object' || user === null) return false
  const u = user as Record<string, unknown>
  if (typeof u.id !== 'string' || !UUID_RE.test(u.id)) return false
  if (typeof u.email !== 'string' || u.email.toLowerCase() !== expectedEmail) return false
  if (typeof u.created_at !== 'string') return false
  const created = Date.parse(u.created_at)
  const nb = Date.parse(notBefore)
  // one second of clock tolerance between GoTrue and Postgres
  return !Number.isNaN(created) && !Number.isNaN(nb) && created >= nb - 1000
}

/**
 * A user created by inviteUserByEmail may be deleted by the cleanup path only if it is that very e-mail and it never confirmed
 * (a confirmed account may already be in use somewhere: never delete it).
 */
export function isDeletableInvitee(user: unknown, expectedEmail: string | null): boolean {
  if (typeof user !== 'object' || user === null) return false
  const u = user as Record<string, unknown>
  if (u.email_confirmed_at !== null && u.email_confirmed_at !== undefined) return false
  if (u.confirmed_at !== null && u.confirmed_at !== undefined) return false
  if (expectedEmail !== null && (typeof u.email !== 'string' || u.email.toLowerCase() !== expectedEmail)) return false
  return true
}

/** The redirect target of the invitation e-mail: an absolute https URL (http only for localhost), no credentials / fragment. */
export function isSafeRedirect(url: string | undefined | null): url is string {
  if (!url) return false
  try {
    const u = new URL(url)
    if (u.username || u.password || u.hash) return false
    if (u.protocol === 'https:') return true
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost'))
  } catch {
    return false
  }
}

export type FailureKind =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'mfa_required'
  | 'not_found'
  | 'email_in_use'
  | 'username_taken'
  | 'staff_limit_reached'
  | 'invalid_state'
  | 'rate_limited'
  | 'payload_too_large'
  | 'method_not_allowed'
  | 'forbidden_origin'
  | 'server_error'

/** Stable machine code (PostgREST error.message, rpc-conventions.md) -> generic failure the portal can act on. */
export function mapRpcError(message: unknown): FailureKind {
  switch (typeof message === 'string' ? message : '') {
    case 'mfa_required':
      return 'mfa_required'
    case 'permission_denied':
    case 'not_authenticated':
    case 'tenant_suspended':
    case 'tenant_read_only':
      return 'forbidden'
    case 'not_found':
      return 'not_found'
    case 'email_in_use':
      return 'email_in_use'
    case 'username_taken':
      return 'username_taken'
    case 'staff_limit_reached':
      return 'staff_limit_reached'
    case 'invalid_state':
    case 'invitation_expired':
    case 'invitation_revoked':
      return 'invalid_state'
    case 'invite_rate_limited':
      return 'rate_limited'
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
    case 'unauthorized':
      return json(401, 'unauthorized')
    case 'forbidden':
    case 'forbidden_origin':
      return json(403, 'forbidden')
    case 'mfa_required':
      return json(403, 'mfa_required')
    case 'not_found':
      return json(404, 'not_found')
    case 'email_in_use':
      return json(409, 'email_in_use')
    case 'username_taken':
      return json(409, 'username_taken')
    case 'staff_limit_reached':
      return json(409, 'staff_limit_reached')
    case 'invalid_state':
      return json(409, 'invalid_state')
    case 'payload_too_large':
      return json(413, 'invalid_request')
    case 'method_not_allowed':
      return json(405, 'invalid_request', { Allow: 'POST, OPTIONS' })
    case 'rate_limited':
      return json(429, 'try_later', { 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec ?? 60))) })
    case 'server_error':
      return json(503, 'server_error')
  }
}

/** Whitelisted success bodies. */
export function shapeSuccess(action: InviteAction['action'], invitationId: string, expiresAt?: string): ShapedResponse {
  if (action === 'invite') {
    return { status: 201, body: { invitation_id: invitationId, expires_at: expiresAt ?? null }, headers: { ...NO_STORE } }
  }
  if (action === 'resend') return { status: 200, body: { invitation_id: invitationId, resent: true }, headers: { ...NO_STORE } }
  return { status: 200, body: { invitation_id: invitationId, status: 'revoked' }, headers: { ...NO_STORE } }
}
