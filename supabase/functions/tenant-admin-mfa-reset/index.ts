// tenant-admin-mfa-reset: a Super Admin removes the authenticator(s) of a Tenant Admin who lost them (owner decision 2026-10-11),
// so that person can sign in with the password and enrol a new one. Platform Admin Portal only.
//
//   1. verify the caller's JWT with Supabase Auth, rate limit per IP and per user;
//   2. fn_platform_prepare_mfa_reset(restaurant_id, profile_id, reason) AS THE CALLER: fn_platform_guard (active Super Admin, MFA
//      session), fn_require_recent_totp (a real TOTP at most 12 h old), reason 3..500, target = an ACTIVE tenant_admin of that
//      restaurant (anything else not_found), never the caller, a verified factor must exist (no_factor). Audited
//      (admin_audit_log tenant_admin.mfa_reset_requested). Returns every factor id of that user;
//   3. SERVICE ROLE: admin.auth.admin.mfa.deleteFactor({ id, userId }) for each factor (GoTrue owns auth.mfa_factors);
//   4. SERVICE ROLE: fn_platform_complete_mfa_reset(profile_id, caller id, reason): refuses while a verified factor remains
//      (factors_remain: then nothing is revoked and the reset can be retried), revokes the user's trusted devices, drops their
//      device attestations, deletes their auth sessions (signed out everywhere). Audited (admin_audit_log tenant_admin.mfa_reset with
//      the caller as actor; the tenant's audit_logs auth.mfa_reset_by_platform).
// Step 4 runs even when an individual deletion failed: the database decides from the factors that remain. Returns
// { profile_id, mfa_reset, sessions_revoked, devices_revoked }. Nothing sensitive is logged.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { readLimitedBody } from '../_shared/body.ts'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readMfaResetEnv } from '../_shared/env.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import { extractBearer } from '../staff-create/logic.ts'
import {
  MAX_BODY_BYTES,
  interpretComplete,
  interpretPrepare,
  mapRpcError,
  parseMfaResetBody,
  shapeFailure,
  shapeSuccess,
  type MfaResetInput,
  type ShapedResponse,
} from './logic.ts'

const env = readMfaResetEnv()
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

  const done = await admin.rpc('fn_platform_complete_mfa_reset', {
    p_profile_id: input.profile_id,
    p_actor: callerId,
    p_reason: input.reason,
  })
  if (done.error) return shapeFailure('server_error')
  const result = interpretComplete(done.data, input.profile_id)
  if (!result) return shapeFailure('server_error')
  return shapeSuccess(input.profile_id, result)
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
