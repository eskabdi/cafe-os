// staff-pin-reset: a staff manager (users.manage, typically the tenant_admin) sets a NEW PIN for a PIN staff member (forgotten
// PIN, lockout that should not simply be lifted). Phase 3B Tenant Portal.
//
//   1. verify the caller's JWT with Supabase Auth, rate limit per user and IP;
//   2. fn_prepare_pin_reset(profile_id) AS THE CALLER: users.manage, step-up (enrolled admins on aal2), own tenant only (foreign and
//      unknown ids are both not_found), never yourself, never a tenant_admin / platform admin (pin_not_allowed), active accounts only,
//      non-escalation (the caller must cover the target's role). Audited (auth.pin_reset_requested, real actor);
//   3. the PIN length must match the target's role (Cashier 6, others 4; the role name comes from the database);
//   4. fn_set_user_pin(profile, HMAC-SHA256(pin, PIN_PEPPER), length) with the SERVICE ROLE: bcrypt, lockout cleared, any forced-change
//      flag / pending approval cleared (an admin-set PIN is the admin's decision). Audited (auth.pin_set).
// The raw PIN never reaches SQL or a log. Returns only { profile_id, pin_reset }.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { readLimitedBody } from '../_shared/body.ts'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readPinResetEnv } from '../_shared/env.ts'
import { computePinDigest } from '../_shared/pin.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import { extractBearer } from '../staff-create/logic.ts'
import {
  MAX_BODY_BYTES,
  interpretPrepare,
  mapRpcError,
  parsePinResetBody,
  shapeFailure,
  shapeSuccess,
  type PinResetInput,
  type ShapedResponse,
} from './logic.ts'

const env = readPinResetEnv()
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
const ipLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5, maxKeys: 5000 })
const userLimiter = createRateLimiter({ capacity: 20, refillPerSec: 1 / 6, maxKeys: 5000 })

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { ...shaped.headers, ...corsHeaders(origin) } })
}

async function reset(token: string, input: PinResetInput): Promise<ShapedResponse> {
  if (!env) return shapeFailure('server_error')
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, noSession)
  const caller = createClient(env.supabaseUrl, env.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } })

  const who = await caller.auth.getUser(token)
  const callerId = who.data?.user?.id
  if (who.error || !callerId) return shapeFailure('unauthorized')
  if (!userLimiter.take(`u:${callerId}`).allowed) return shapeFailure('rate_limited')

  const prep = await caller.rpc('fn_prepare_pin_reset', { p_profile_id: input.profile_id })
  if (prep.error) return shapeFailure(mapRpcError(prep.error.message))
  const prepared = interpretPrepare(prep.data, input.profile_id)
  if (!prepared) return shapeFailure('server_error')
  if (input.pin.length !== prepared.pinLength) return shapeFailure('invalid_pin_length')

  const digest = await computePinDigest(input.pin, env.pinPepper)
  const set = await admin.rpc('fn_set_user_pin', { p_profile_id: input.profile_id, p_pin_digest: digest, p_pin_length: prepared.pinLength })
  if (set.error) return shapeFailure('server_error')
  return shapeSuccess(input.profile_id)
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
  const parsed = parsePinResetBody(text)
  if (!parsed.ok) return respond(shapeFailure(parsed.error), origin)

  let shaped: ShapedResponse
  try {
    shaped = await reset(token, parsed.value)
  } catch {
    console.error('staff-pin-reset: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status >= 400) console.warn(`staff-pin-reset: denied status=${shaped.status}`)
  return respond(shaped, origin)
})
