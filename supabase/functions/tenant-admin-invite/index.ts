// tenant-admin-invite: invite a Tenant Admin by e-mail (Phase 3B). Callers: a platform super admin (for a named tenant, e.g. the
// first admin of a freshly provisioned tenant) or the tenant's own tenant_admin (a co-admin of the caller's tenant).
//
// Authorisation is the DATABASE's, AS THE CALLER (the caller's JWT, including its aal claim, is forwarded):
//   fn_prepare_tenant_admin_invitation      platform: fn_platform_guard (active super admin, aal2, verified factor)
//                                           tenant:   tenant guard + is_tenant_admin + fn_require_aal2; tenant from identity
// The service role (confined to this function) only does what the caller cannot:
//   deliver: fn_plan_tenant_admin_invitation_delivery -> by mode: none (decoy) | invite | replace_unconfirmed | reinvite |
//            magic_link -> fn_attach_tenant_admin_invitation -> fn_record_tenant_admin_invitation_sent (only after success)
//   invite:  fn_prepare_tenant_admin_invitation (caller) -> deliver; a failed first delivery -> fn_abort_tenant_admin_invitation
//   resend:  fn_prepare_tenant_admin_invitation_resend (caller; attempts 60 s apart, 5 successful sends) -> deliver
//   revoke:  fn_revoke_tenant_admin_invitation (caller) -> fn_tenant_admin_invitation_cleanup_user (service) -> delete that
//            never-confirmed Auth user
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
  interpretCleanup,
  interpretPlan,
  interpretPrepare,
  interpretResend,
  interpretRevoke,
  isDeletableInvitee,
  isFreshlyCreated,
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

  // one delivery, shared by the first send and every resend. The DATABASE plans it (fn_plan_tenant_admin_invitation_delivery)
  // and records it only after it succeeded (fn_record_tenant_admin_invitation_sent): a failed attempt consumes no send budget.
  const deliver = async (invitationId: string, email: string): Promise<boolean> => {
    const planned = await admin.rpc('fn_plan_tenant_admin_invitation_delivery', { p_invitation_id: invitationId })
    if (planned.error) return false
    const plan = interpretPlan(planned.data, invitationId)
    if (!plan || plan.email !== email) return false
    if (plan.mode === 'none') return true // decoy: recorded by the plan itself, nothing leaves the system

    let userId: string | null = plan.authUserId
    let created: string | null = null
    if (plan.mode === 'replace_unconfirmed' && plan.authUserId) {
      // an orphan, never-confirmed account is never re-used (pre-hijack): delete it, then invite afresh
      const u = await admin.auth.admin.getUserById(plan.authUserId)
      if (u.error || !isDeletableInvitee(u.data?.user, email)) return false
      const del = await admin.auth.admin.deleteUser(plan.authUserId)
      if (del.error) return false
      userId = null
    }
    if (plan.mode === 'invite' || plan.mode === 'replace_unconfirmed') {
      const sent = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: env.inviteRedirectUrl })
      if (sent.error || !sent.data?.user) return false
      // never adopt an account that existed before this attempt (and never delete it either)
      if (!isFreshlyCreated(sent.data.user, email, plan.notBefore)) return false
      userId = sent.data.user.id
      created = userId
    } else if (plan.mode === 'reinvite') {
      const sent = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: env.inviteRedirectUrl })
      if (sent.error || sent.data?.user?.id !== plan.authUserId) return false
    }
    if (!userId) return false
    const attached = await admin.rpc('fn_attach_tenant_admin_invitation', { p_invitation_id: invitationId, p_auth_user_id: userId })
    if (attached.error) {
      if (created) {
        const u = await admin.auth.admin.getUserById(created)
        if (!u.error && isDeletableInvitee(u.data?.user, email)) await admin.auth.admin.deleteUser(created)
      }
      return false
    }
    if (plan.mode === 'magic_link') {
      // confirmed account without a profile (review H2): a sign-in link, never a new account
      const link = await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: env.inviteRedirectUrl } })
      if (link.error) return false
    }
    const recorded = await admin.rpc('fn_record_tenant_admin_invitation_sent', { p_invitation_id: invitationId })
    return !recorded.error
  }

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
    let ok = false
    try {
      ok = await deliver(reserved.invitationId, reserved.email)
    } catch {
      ok = false
    }
    if (!ok) {
      // compensation: the first send never happened -> release the reservation (no-op once a send was recorded)
      try {
        await admin.rpc('fn_abort_tenant_admin_invitation', { p_invitation_id: reserved.invitationId })
      } catch {
        console.error('tenant-admin-invite: abort_failed')
      }
      return fail('server_error')
    }
    return shapeSuccess('invite', reserved.invitationId, reserved.expiresAt)
  }

  if (input.action === 'resend') {
    const prep = await caller.rpc('fn_prepare_tenant_admin_invitation_resend', { p_invitation_id: input.invitation_id })
    if (prep.error) return fail(mapRpcError(prep.error.message))
    const target = interpretResend(prep.data, input.invitation_id)
    if (!target) return fail('server_error')
    let ok = false
    try {
      ok = await deliver(input.invitation_id, target.email)
    } catch {
      ok = false
    }
    // a failed resend leaves the invitation as it was (nothing recorded, nothing to compensate)
    return ok ? shapeSuccess('resend', input.invitation_id) : fail('server_error')
  }

  const rev = await caller.rpc('fn_revoke_tenant_admin_invitation', { p_invitation_id: input.invitation_id })
  if (rev.error) return fail(mapRpcError(rev.error.message))
  if (!interpretRevoke(rev.data, input.invitation_id)) return fail('server_error')
  try {
    const c = await admin.rpc('fn_tenant_admin_invitation_cleanup_user', { p_invitation_id: input.invitation_id })
    const out = c.error ? null : interpretCleanup(c.data, input.invitation_id)
    if (out?.cleanupUserId) {
      const u = await admin.auth.admin.getUserById(out.cleanupUserId)
      if (!u.error && isDeletableInvitee(u.data?.user, null)) await admin.auth.admin.deleteUser(out.cleanupUserId)
    }
  } catch {
    // the invitation is already revoked in the database (the account cannot bind); a leftover unconfirmed user is harmless
    console.error('tenant-admin-invite: cleanup_failed')
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
