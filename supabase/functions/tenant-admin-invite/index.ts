// tenant-admin-invite: invite a Tenant Admin by e-mail (Phase 3B). Callers: a platform super admin (for a named tenant, e.g. the
// first admin of a freshly provisioned tenant) or the tenant's own tenant_admin (a co-admin of the caller's tenant).
//
// Authorisation is the DATABASE's, AS THE CALLER (the caller's JWT, including its aal claim, is forwarded):
//   fn_prepare_tenant_admin_invitation      platform: fn_platform_guard (active super admin, aal2, verified factor)
//                                           tenant:   tenant guard + is_tenant_admin + fn_require_aal2; tenant from identity
// The service role (confined to this function) only does what the caller cannot:
//   invite:  auth.admin.inviteUserByEmail(email, redirectTo) -> fn_attach_tenant_admin_invitation(invitation, user)
//            any failure after the reservation -> fn_abort_tenant_admin_invitation (+ delete the never-confirmed user we created)
//   resend:  fn_prepare_tenant_admin_invitation_resend (caller; rate limited 60 s / 5 sends) -> inviteUserByEmail again
//            (GoTrue re-sends to an unconfirmed user) and the returned user must be the attached one
//   revoke:  fn_revoke_tenant_admin_invitation (caller) -> delete the Auth user it hands back (never-confirmed only)
// The invitee binds itself later with fn_accept_tenant_admin_invitation() (no Edge Function needed: its own session).
// Every step is audited in SQL (audit_logs; admin_audit_log when the platform acts). Nothing sensitive is logged here.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { readLimitedBody } from '../_shared/body.ts'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readInviteEnv } from '../_shared/env.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import { extractBearer } from '../staff-create/logic.ts'
import {
  MAX_BODY_BYTES,
  interpretPrepare,
  interpretResend,
  interpretRevoke,
  isDeletableInvitee,
  isSafeRedirect,
  mapRpcError,
  parseInviteBody,
  shapeFailure,
  shapeSuccess,
  type FailureKind,
  type InviteAction,
  type ShapedResponse,
} from './logic.ts'

const env = readInviteEnv((u) => isSafeRedirect(u))
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
const ipLimiter = createRateLimiter({ capacity: 20, refillPerSec: 0.2, maxKeys: 5000 })
const userLimiter = createRateLimiter({ capacity: 10, refillPerSec: 1 / 30, maxKeys: 5000 })

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { ...shaped.headers, ...corsHeaders(origin) } })
}

async function handle(token: string, input: InviteAction): Promise<ShapedResponse> {
  if (!env) return shapeFailure('server_error')
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, noSession)
  const caller = createClient(env.supabaseUrl, env.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } })

  const who = await caller.auth.getUser(token)
  const callerId = who.data?.user?.id
  if (who.error || !callerId) return shapeFailure('unauthorized')
  if (!userLimiter.take(`u:${callerId}`).allowed) return shapeFailure('rate_limited')
  const fail = (kind: FailureKind): ShapedResponse => shapeFailure(kind)

  if (input.action === 'invite') {
    const prep = await caller.rpc('fn_prepare_tenant_admin_invitation', {
      p_restaurant_id: input.restaurant_id,
      p_email: input.email,
      p_first_name: input.first_name,
      p_middle_name: input.middle_name,
      p_last_name: input.last_name,
      p_username: input.username,
    })
    if (prep.error) return fail(mapRpcError(prep.error.message))
    const reserved = interpretPrepare(prep.data, input.email)
    if (!reserved) return fail('server_error')

    const abort = async (createdUserId: string | null): Promise<void> => {
      try {
        if (createdUserId) {
          const u = await admin.auth.admin.getUserById(createdUserId)
          if (!u.error && isDeletableInvitee(u.data?.user, input.email)) await admin.auth.admin.deleteUser(createdUserId)
        }
        await admin.rpc('fn_abort_tenant_admin_invitation', { p_invitation_id: reserved.invitationId })
      } catch {
        console.error('tenant-admin-invite: abort_failed')
      }
    }

    const sent = await admin.auth.admin.inviteUserByEmail(input.email, { redirectTo: env.inviteRedirectUrl })
    const userId = sent.data?.user?.id
    if (sent.error || !userId) {
      await abort(null)
      return fail('server_error')
    }
    const attached = await admin.rpc('fn_attach_tenant_admin_invitation', { p_invitation_id: reserved.invitationId, p_auth_user_id: userId })
    if (attached.error) {
      await abort(userId)
      return fail('server_error')
    }
    return shapeSuccess('invite', reserved.invitationId, reserved.expiresAt)
  }

  if (input.action === 'resend') {
    const prep = await caller.rpc('fn_prepare_tenant_admin_invitation_resend', { p_invitation_id: input.invitation_id })
    if (prep.error) return fail(mapRpcError(prep.error.message))
    const target = interpretResend(prep.data, input.invitation_id)
    if (!target) return fail('server_error')
    const sent = await admin.auth.admin.inviteUserByEmail(target.email, { redirectTo: env.inviteRedirectUrl })
    if (sent.error || sent.data?.user?.id !== target.authUserId) return fail('server_error')
    return shapeSuccess('resend', input.invitation_id)
  }

  const rev = await caller.rpc('fn_revoke_tenant_admin_invitation', { p_invitation_id: input.invitation_id })
  if (rev.error) return fail(mapRpcError(rev.error.message))
  const out = interpretRevoke(rev.data, input.invitation_id)
  if (!out) return fail('server_error')
  if (out.cleanupUserId) {
    try {
      const u = await admin.auth.admin.getUserById(out.cleanupUserId)
      if (!u.error && isDeletableInvitee(u.data?.user, null)) await admin.auth.admin.deleteUser(out.cleanupUserId)
    } catch {
      // the invitation is already revoked in the database (the account cannot bind); a leftover unconfirmed user is harmless
      console.error('tenant-admin-invite: cleanup_failed')
    }
  }
  return shapeSuccess('revoke', input.invitation_id)
}

Deno.serve(async (req: Request): Promise<Response> => {
  const originHeader = req.headers.get('origin')
  const origin = resolveAllowedOrigin(originHeader, allowedOrigins)
  if (req.method === 'OPTIONS') {
    return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : respond(shapeFailure('forbidden_origin'), null)
  }
  if (originHeader && !origin) return respond(shapeFailure('forbidden_origin'), null)
  if (req.method !== 'POST') return respond(shapeFailure('method_not_allowed'), origin)

  const ipDecision = ipLimiter.take(`ip:${clientIp(req.headers)}`)
  if (!ipDecision.allowed) return respond(shapeFailure('rate_limited', ipDecision.retryAfterSec), origin)

  const token = extractBearer(req.headers.get('authorization'))
  if (!token) return respond(shapeFailure('unauthorized'), origin)

  const text = await readLimitedBody(req, MAX_BODY_BYTES)
  if (text === null) return respond(shapeFailure('payload_too_large'), origin)
  const parsed = parseInviteBody(text)
  if (!parsed.ok) return respond(shapeFailure(parsed.error), origin)

  let shaped: ShapedResponse
  try {
    shaped = await handle(token, parsed.value)
  } catch {
    console.error('tenant-admin-invite: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status >= 400) console.warn(`tenant-admin-invite: denied status=${shaped.status}`)
  return respond(shaped, origin)
})
