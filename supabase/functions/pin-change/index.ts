// pin-change: a signed-in PIN staff member changes their OWN PIN. This is the only thing a user can do while
// profile_secrets.must_change_pin is true (and, after the change, the account stays restricted until a tenant_admin approves) (the DB denies every permission-checked RPC meanwhile; see migration 0023).
//
// Flow:
//   1. verify_jwt (gateway) + auth.getUser(jwt): the user is identified from the JWT ONLY; the body carries no id;
//   2. strict body parse (exact keys, 4/6 digits, weak-PIN policy, new != current), per-user and per-IP throttle;
//   3. service-role lookup of the caller's profile + role name (never from the client): must be an active auth_method='pin'
//      non-admin member, else the same generic 401 as a wrong PIN; new PIN length must match the role (Cashier 6, others 4;
//      pinLengthForRole in _shared/pin.ts: the one documented name-keyed rule, not repeated here);
//   4. fn_verify_pin(profile, HMAC(current_pin)): the same lockout counter as pin-login; uniform failure;
//   5. fn_complete_forced_pin_change(profile, HMAC(new_pin), length): stores the new bcrypt'd digest. If the account was
//      flagged (must_change_pin) it becomes pending_approval and every tenant_admin is notified (maker-checker, migration 0024);
//      otherwise it is a plain voluntary change. Response says which: pending_approval;
//   6. auth.admin.signOut(jwt, 'others'): every OTHER session of this user ends (a compromised session dies). The session
//      making the change survives. A failure here is reported as other_sessions_revoked=false, never hidden.
// Same CORS / no-store / body-size / timing-floor hygiene as pin-login. Nothing sensitive is logged.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readPinLoginEnv } from '../_shared/env.ts'
import { computePinDigest, pinLengthForRole } from '../_shared/pin.ts'
import {
  MAX_BODY_BYTES,
  clientIp,
  createRateLimiter,
  extractBearer,
  interpretCompleteResult,
  interpretVerifyResult,
  isChangeCandidate,
  parsePinChangeBody,
  pinLengthOk,
  remainingDelayMs,
  shapeFailure,
  shapeSuccess,
  type FailureKind,
  type PinChangeInput,
  type ShapedResponse,
} from './logic.ts'

const env = readPinLoginEnv()
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
// best effort per isolate; the DB lockout in fn_verify_pin is authoritative
const ipLimiter = createRateLimiter({ capacity: 20, refillPerSec: 0.2, maxKeys: 5000 })
const userLimiter = createRateLimiter({ capacity: 6, refillPerSec: 1 / 30, maxKeys: 5000 })

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { ...shaped.headers, ...corsHeaders(origin) } })
}

async function readLimitedBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.byteLength
  }
  return new TextDecoder().decode(buf)
}

type Outcome = { ok: true; pendingApproval: boolean; othersRevoked: boolean } | { ok: false; kind: FailureKind }

async function changePin(token: string, input: PinChangeInput): Promise<Outcome> {
  if (!env) return { ok: false, kind: 'server_error' }
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, noSession)
  const caller = createClient(env.supabaseUrl, env.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } })

  // 1. identity from the JWT only (accepted by Supabase Auth, not merely decodable)
  const who = await caller.auth.getUser(token)
  const userId = who.data?.user?.id
  if (who.error || !userId) return { ok: false, kind: 'unauthorized' }
  if (!userLimiter.take(`u:${userId}`).allowed) return { ok: false, kind: 'rate_limited' }

  // 2. the caller's profile and role NAME, server-side
  const prof = await admin.from('profiles').select('id, restaurant_id, role_id, auth_method, is_active').eq('id', userId).maybeSingle()
  if (prof.error) return { ok: false, kind: 'server_error' }
  if (!isChangeCandidate(prof.data, userId)) {
    // admins, password users, inactive and unknown profiles: burn the same DB work, answer like a wrong PIN
    await admin.rpc('fn_verify_pin', { p_profile_id: crypto.randomUUID(), p_pin_digest: await computePinDigest(input.current_pin, env.pinPepper) })
    return { ok: false, kind: 'invalid_credentials' }
  }
  const role = await admin.from('roles').select('name').eq('id', prof.data.role_id).eq('restaurant_id', prof.data.restaurant_id).maybeSingle()
  const roleName = (role.data as { name?: unknown } | null)?.name
  if (role.error || typeof roleName !== 'string') return { ok: false, kind: 'server_error' }
  if (!pinLengthOk(input.new_pin, roleName)) return { ok: false, kind: 'invalid_pin_length' }

  // 3. the current PIN, through the same lockout as pin-login
  const verify = await admin.rpc('fn_verify_pin', {
    p_profile_id: userId,
    p_pin_digest: await computePinDigest(input.current_pin, env.pinPepper),
  })
  if (verify.error) return { ok: false, kind: 'server_error' }
  if (interpretVerifyResult(verify.data, { profileId: userId, restaurantId: prof.data.restaurant_id }).kind !== 'ok') {
    return { ok: false, kind: 'invalid_credentials' }
  }

  // 4. set the new PIN. fn_complete_forced_pin_change decides under the row lock whether the account was flagged: a flagged
  //    account becomes pending_approval (a tenant_admin must approve before access returns); a voluntary change behaves
  //    exactly like fn_set_user_pin. Always this function (never fn_set_user_pin) so a pending account cannot skip approval.
  const set = await admin.rpc('fn_complete_forced_pin_change', {
    p_profile_id: userId,
    p_pin_digest: await computePinDigest(input.new_pin, env.pinPepper),
    p_pin_length: pinLengthForRole(roleName),
  })
  if (set.error) return { ok: false, kind: 'server_error' }
  const pendingApproval = interpretCompleteResult(set.data)
  if (pendingApproval === null) return { ok: false, kind: 'server_error' }

  // 5. end every OTHER session of this user; the one that just proved the old PIN stays
  let othersRevoked = false
  try {
    const out = await admin.auth.admin.signOut(token, 'others')
    othersRevoked = !out.error
  } catch {
    console.error('pin-change: revoke_others_failed') // fixed code only
  }
  return { ok: true, pendingApproval, othersRevoked }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const startedAt = Date.now()
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

  const text = await readLimitedBody(req)
  if (text === null) return respond(shapeFailure('payload_too_large'), origin)
  const parsed = parsePinChangeBody(text)
  if (!parsed.ok) return respond(shapeFailure(parsed.error), origin)

  let shaped: ShapedResponse
  try {
    const out = await changePin(token, parsed.value)
    shaped = out.ok ? shapeSuccess(out.pendingApproval, out.othersRevoked) : shapeFailure(out.kind)
  } catch {
    console.error('pin-change: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status >= 400) console.warn(`pin-change: denied status=${shaped.status}`)
  await sleep(remainingDelayMs(startedAt, Date.now()))
  return respond(shaped, origin)
})
