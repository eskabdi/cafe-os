// tenant-admin-mfa-reset: a Super Admin removes the authenticator(s) of a Tenant Admin who lost them (owner decision 2026-10-11),
// and FORCES CREDENTIAL RE-PROOF: the password is rotated to a random value and a recovery e-mail goes to the registered address,
// so a phone call plus a stolen password is not enough to take the account over. Platform Admin Portal only.
//
//   1. verify the caller's JWT with Supabase Auth, rate limit per IP and per user;
//   2. fn_platform_prepare_mfa_reset(restaurant_id, profile_id, reason) AS THE CALLER: fn_platform_guard (active Super Admin, MFA
//      session), fn_require_recent_totp (a real TOTP at most 12 h old), reason 3..500, target = an ACTIVE tenant_admin of that
//      restaurant (anything else not_found), never the caller, a verified factor must exist (no_factor) unless a half-done reset is
//      being finished. Inserts a single-use public.mfa_resets row (expires in 5 min). Audited (tenant_admin.mfa_reset_requested).
//      Returns { reset_id, profile_id, user_id, factor_ids } (factor_ids may be empty when finishing);
//   3. SERVICE ROLE: admin.auth.admin.mfa.deleteFactor({ id, userId }) for each factor (GoTrue owns auth.mfa_factors);
//   4. SERVICE ROLE: admin.auth.admin.updateUserById(userId, { password: <32 random bytes> }); the value is never logged or
//      returned. If this fails the reset is NOT completed (503, retry: prepare lets the Super Admin finish it);
//   5. SERVICE ROLE: fn_platform_complete_mfa_reset(reset_id): consumes the row (expired / completed / superseded refused), derives
//      actor, target, tenant and reason from it, re-checks both, refuses while a verified factor remains (factors_remain), revokes the
//      trusted devices, drops attestations, deletes auth sessions (null when not permitted), stamps completed_at: from then on only
//      sessions created after the reset pass any MFA gate (fn_mfa_session_ok / fn_require_recent_totp). Audited (admin_audit_log
//      tenant_admin.mfa_reset; the tenant's audit_logs auth.mfa_reset_by_platform, with the reason);
//   6. anon client: resetPasswordForEmail(<registered e-mail>, { redirectTo: RECOVERY_REDIRECT_URL }) AFTER completion (so the
//      recovery session is newer than completed_at). A failure here does not undo the reset: recovery_sent = false.
// Returns { profile_id, mfa_reset, factors_removed, sessions_revoked, devices_revoked, password_rotated, recovery_sent }. Nothing
// sensitive is logged.
//
// NOT EXECUTED against a real Supabase stack (see README.md); the pure logic is unit-tested and the SQL is pgTAP-tested.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { readLimitedBody } from '../_shared/body.ts'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readMfaResetEnv } from '../_shared/env.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import { extractBearer } from '../staff-create/logic.ts'
import { isSafeRedirect } from '../tenant-admin-invite/logic.ts'
import {
  MAX_BODY_BYTES,
  interpretComplete,
  interpretPrepare,
  mapCompleteError,
  mapRpcError,
  parseMfaResetBody,
  rotationPassword,
  shapeFailure,
  shapeSuccess,
  type MfaResetInput,
  type ShapedResponse,
} from './logic.ts'

const env = readMfaResetEnv(isSafeRedirect)
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
const ipLimiter = createRateLimiter({ capacity: 20, refillPerSec: 0.2, maxKeys: 5000 })
const userLimiter = createRateLimiter({ capacity: 5, refillPerSec: 1 / 60, maxKeys: 5000 })

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { ...shaped.headers, ...corsHeaders(origin) } })
}

async function reset(token: string, input: MfaResetInput): Promise<ShapedResponse> {
  if (!env) return shapeFailure('server_error')
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, noSession)
  const caller = createClient(env.supabaseUrl, env.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } })

  const who = await caller.auth.getUser(token)
  const callerId = who.data?.user?.id
  if (who.error || !callerId) return shapeFailure('unauthorized')
  if (!userLimiter.take(`u:${callerId}`).allowed) return shapeFailure('rate_limited')

  const prep = await caller.rpc('fn_platform_prepare_mfa_reset', {
    p_restaurant_id: input.restaurant_id,
    p_profile_id: input.profile_id,
    p_reason: input.reason,
  })
  if (prep.error) return shapeFailure(mapRpcError(prep.error.message, prep.error.details))
  const prepared = interpretPrepare(prep.data, input.profile_id)
  if (!prepared) return shapeFailure('server_error')

  let failed = 0
  for (const id of prepared.factorIds) {
    const del = await admin.auth.admin.mfa.deleteFactor({ id, userId: prepared.userId })
    if (del.error) failed += 1
  }
  if (failed > 0) console.warn(`tenant-admin-mfa-reset: factor_delete_failed count=${failed}`)

  // credential re-proof: whoever knew the old password (e.g. the caller on the phone) can no longer use it
  const rotated = await admin.auth.admin.updateUserById(prepared.userId, { password: rotationPassword() })
  if (rotated.error) {
    console.warn('tenant-admin-mfa-reset: password_rotation_failed')
    return shapeFailure('server_error')
  }

  const done = await admin.rpc('fn_platform_complete_mfa_reset', { p_reset_id: prepared.resetId })
  if (done.error) return shapeFailure(mapCompleteError(done.error.message, done.error.details))
  const result = interpretComplete(done.data, input.profile_id)
  if (!result) return shapeFailure('server_error')
  if (!result.ok) return shapeFailure(result.kind)

  const recoverySent = await sendRecovery(admin, prepared.userId)
  if (!recoverySent) console.warn('tenant-admin-mfa-reset: recovery_email_not_sent')
  return shapeSuccess(input.profile_id, result, prepared.factorIds.length - failed, recoverySent)
}

/** The recovery e-mail to the user's REGISTERED address (read with the service role, never taken from the request). */
async function sendRecovery(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!env) return false
  try {
    const u = await admin.auth.admin.getUserById(userId)
    const email = u.data?.user?.email
    if (u.error || !email) return false
    const anon = createClient(env.supabaseUrl, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: 'implicit' },
    })
    const sent = await anon.auth.resetPasswordForEmail(email, { redirectTo: env.recoveryRedirectUrl })
    return !sent.error
  } catch {
    return false
  }
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
  const parsed = parseMfaResetBody(text)
  if (!parsed.ok) return respond(shapeFailure(parsed.error), origin)

  let shaped: ShapedResponse
  try {
    shaped = await reset(token, parsed.value)
  } catch {
    console.error('tenant-admin-mfa-reset: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status >= 400) console.warn(`tenant-admin-mfa-reset: denied status=${shaped.status}`)
  return respond(shaped, origin)
})
