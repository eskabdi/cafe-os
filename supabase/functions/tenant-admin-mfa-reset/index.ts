// tenant-admin-mfa-reset: a Super Admin removes the authenticator(s) of a Tenant Admin who lost them (owner decision 2026-10-11),
// and FORCES CREDENTIAL RE-PROOF: the password is rotated to a random value and a recovery e-mail goes to the registered address,
// so a phone call plus a stolen password is not enough to take the account over. Platform Admin Portal only.
//
// action 'reset' (default). The order is chosen so that nothing irreversible happens before the reset row is claimed and the
// authenticator goes LAST (a reset that stops half-way never leaves an account with no factor but a working old password):
//   1. verify the caller's JWT with Supabase Auth, rate limit per IP and per user;
//   2. AS THE CALLER fn_platform_prepare_mfa_reset(restaurant_id, profile_id, reason): fn_platform_guard (active Super Admin, MFA
//      session), fn_require_recent_totp (a real TOTP at most 12 h old), reason 3..500, target = an ACTIVE tenant_admin of that
//      restaurant (anything else not_found), tenant not suspended / cancelled (tenant_suspended), never the caller, a verified
//      factor must exist (no_factor) unless a half-done reset is being finished. Inserts a single-use public.mfa_resets row (expires
//      in 5 min; from now on the user's older sessions fail every MFA gate). Audited (tenant_admin.mfa_reset_requested);
//   3. SERVICE ROLE fn_platform_claim_mfa_reset(reset_id): refuses expired / completed / superseded rows, a second reset of the
//      same user in flight (reset_in_progress), a requester / target / tenant that no longer qualifies; stamps claimed_at. Every
//      refusal happens here, BEFORE anything changes (two concurrent resets can never overwrite a password the user already set
//      from the first recovery link);
//   4. SERVICE ROLE admin.auth.admin.updateUserById(userId, { password: <32 random bytes> }); the value is never logged or returned.
//      If this fails the function stops (503) BEFORE touching sessions or factors;
//   5. SERVICE ROLE fn_platform_mfa_reset_sign_out(reset_id): revokes trusted devices and attestations, deletes auth sessions (null
//      when not permitted). On failure: 503, factors untouched;
//   6. SERVICE ROLE admin.auth.admin.mfa.deleteFactor for each prepared factor id, then admin.auth.admin.mfa.listFactors and delete
//      EVERY factor still listed (one enrolled after the reset was requested is never treated as legitimate);
//   7. SERVICE ROLE fn_platform_complete_mfa_reset(reset_id): re-checks everything, refuses while a verified factor remains
//      (factors_remain), revokes anything that appeared since step 5, stamps completed_at, audits in both trails;
//   8. anon client resetPasswordForEmail(<registered e-mail>, { redirectTo: RECOVERY_REDIRECT_URL }) AFTER completion (so the
//      recovery session is newer than completed_at). A failure here does not undo the reset: recovery_sent = false.
// Returns { profile_id, mfa_reset, factors_removed, sessions_revoked, devices_revoked, password_rotated, recovery_sent }.
//
// action 'resend_recovery': AS THE CALLER fn_platform_prepare_recovery_resend(restaurant_id, profile_id, reason) (same guard, TOTP,
// target and tenant rules; only for an admin with no verified factor whose latest reset is completed, else recovery_not_available;
// audited tenant_admin.recovery_resent + the tenant's auth.recovery_resent_by_platform), then step 8.
// Returns { profile_id, action: 'resend_recovery', recovery_sent }. Nothing sensitive is logged.
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
  interpretClaim,
  interpretComplete,
  interpretPrepare,
  interpretResend,
  interpretSignOut,
  mapCompleteError,
  mapRpcError,
  parseMfaResetBody,
  remainingFactors,
  rotationPassword,
  shapeFailure,
  shapeResendSuccess,
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

  if (input.action === 'resend_recovery') return resendRecovery(caller, admin, input)

  const prep = await caller.rpc('fn_platform_prepare_mfa_reset', {
    p_restaurant_id: input.restaurant_id,
    p_profile_id: input.profile_id,
    p_reason: input.reason,
  })
  if (prep.error) return shapeFailure(mapRpcError(prep.error.message, prep.error.details))
  const prepared = interpretPrepare(prep.data, input.profile_id)
  if (!prepared) return shapeFailure('server_error')

  // claim BEFORE anything changes: every refusal (expired, superseded, another reset in flight, suspended tenant) happens here
  const claim = await admin.rpc('fn_platform_claim_mfa_reset', { p_reset_id: prepared.resetId })
  if (claim.error) return shapeFailure(mapCompleteError(claim.error.message, claim.error.details))
  const claimed = interpretClaim(claim.data, input.profile_id, prepared.resetId)
  if (!claimed) return shapeFailure('server_error')

  // credential re-proof: whoever knew the old password (e.g. the caller on the phone) can no longer use it. Abort on failure:
  // sessions and factors are untouched, the Super Admin runs the reset again
  const rotated = await admin.auth.admin.updateUserById(prepared.userId, { password: rotationPassword() })
  if (rotated.error) {
    console.warn('tenant-admin-mfa-reset: password_rotation_failed')
    return shapeFailure('server_error')
  }

  const out = await admin.rpc('fn_platform_mfa_reset_sign_out', { p_reset_id: prepared.resetId })
  const signedOut = out.error ? null : interpretSignOut(out.data, input.profile_id)
  if (!signedOut) {
    console.warn('tenant-admin-mfa-reset: sign_out_failed')
    return shapeFailure(out.error ? mapCompleteError(out.error.message, out.error.details) : 'server_error')
  }

  // the authenticator goes LAST: the prepared factors, then every factor still listed (never trust one that appeared meanwhile)
  let removed = 0
  let failed = 0
  const tryDelete = async (id: string) => {
    const del = await admin.auth.admin.mfa.deleteFactor({ id, userId: prepared.userId })
    if (del.error) failed += 1
    else removed += 1
  }
  for (const id of claimed.factorIds) await tryDelete(id)
  const listed = await admin.auth.admin.mfa.listFactors({ userId: prepared.userId })
  const left = listed.error ? null : remainingFactors(listed.data, claimed.createdAt)
  if (!left) {
    console.warn('tenant-admin-mfa-reset: factor_list_failed')
    return shapeFailure('server_error')
  }
  if (left.late > 0) console.warn(`tenant-admin-mfa-reset: factor_enrolled_during_reset count=${left.late}`)
  for (const id of left.ids) await tryDelete(id)
  if (failed > 0) console.warn(`tenant-admin-mfa-reset: factor_delete_failed count=${failed}`)

  const done = await admin.rpc('fn_platform_complete_mfa_reset', { p_reset_id: prepared.resetId })
  if (done.error) return shapeFailure(mapCompleteError(done.error.message, done.error.details))
  const result = interpretComplete(done.data, input.profile_id)
  if (!result) return shapeFailure('server_error')
  if (!result.ok) return shapeFailure(result.kind)

  const recoverySent = await sendRecovery(admin, prepared.userId)
  if (!recoverySent) console.warn('tenant-admin-mfa-reset: recovery_email_not_sent')
  // the completion reports totals (it adds the sign-out step's counts recorded on the reset row)
  return shapeSuccess(input.profile_id, result, removed, recoverySent)
}

/** action 'resend_recovery': the audited caller-scoped check, then the recovery e-mail to the registered address. */
async function resendRecovery(caller: SupabaseClient, admin: SupabaseClient, input: MfaResetInput): Promise<ShapedResponse> {
  const prep = await caller.rpc('fn_platform_prepare_recovery_resend', {
    p_restaurant_id: input.restaurant_id,
    p_profile_id: input.profile_id,
    p_reason: input.reason,
  })
  if (prep.error) return shapeFailure(mapRpcError(prep.error.message, prep.error.details))
  const ok = interpretResend(prep.data, input.profile_id)
  if (!ok) return shapeFailure('server_error')
  const recoverySent = await sendRecovery(admin, ok.userId)
  if (!recoverySent) console.warn('tenant-admin-mfa-reset: recovery_email_not_sent')
  return shapeResendSuccess(input.profile_id, recoverySent)
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
