// staff-create: a staff manager (users.manage) creates a PIN-login staff member.
//
// Flow (every step authorised by the DATABASE, as the caller; the service role only does what the caller cannot):
//   1. verify the caller's JWT with Supabase Auth (user-scoped client), rate limit per user and IP;
//   2. fn_prepare_staff_creation(username, role_id) AS THE CALLER: users.manage, role/username/plan-limit checks,
//      returns the tenant slug (the tenant is never taken from the request);
//   3. create the Auth user with the SERVICE ROLE: synthetic email <username>@<slug>.staff.cafeos.invalid, random
//      32-byte password nobody knows, email_confirm = true, app_metadata.staff = true (not user-writable);
//   4. fn_create_staff_profile(...) AS THE CALLER (the DB re-checks everything, binds email <-> tenant <-> username);
//   5. fn_set_user_pin(profile, HMAC-SHA256(pin, PIN_PEPPER), pin length) with the service role. The raw PIN never reaches SQL;
//   6. ANY failure after step 3 rolls back: delete the profile (if created) and the Auth user.
// Returns only { profile_id }. Errors are generic (see logic.ts mapRpcError). Nothing sensitive is logged.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readStaffCreateEnv } from '../_shared/env.ts'
import { computePinDigest, pinLengthForRole } from '../_shared/pin.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import {
  MAX_BODY_BYTES,
  extractBearer,
  interpretPrepare,
  pinLengthMatchesRole,
  mapRpcError,
  parseStaffCreateBody,
  randomPassword,
  shapeFailure,
  shapeSuccess,
  staffEmail,
  type FailureKind,
  type ShapedResponse,
  type StaffCreateInput,
} from './logic.ts'

const env = readStaffCreateEnv()
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
// best effort per isolate; the DB (users.manage, plan limit) is authoritative
const ipLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5, maxKeys: 5000 })
const userLimiter = createRateLimiter({ capacity: 20, refillPerSec: 1 / 6, maxKeys: 5000 })

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

type Outcome = { ok: true; profileId: string } | { ok: false; kind: FailureKind }

async function createStaff(token: string, input: StaffCreateInput): Promise<Outcome> {
  if (!env) return { ok: false, kind: 'server_error' }
  const noSession = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, noSession)
  const caller = createClient(env.supabaseUrl, env.anonKey, { ...noSession, global: { headers: { Authorization: `Bearer ${token}` } } })

  // 1. the JWT must be accepted by Supabase Auth (not merely decodable)
  const who = await caller.auth.getUser(token)
  const callerId = who.data?.user?.id
  if (who.error || !callerId) return { ok: false, kind: 'unauthorized' }
  if (!userLimiter.take(`u:${callerId}`).allowed) return { ok: false, kind: 'rate_limited' }

  // 2. authorisation + validation, as the caller
  const prep = await caller.rpc('fn_prepare_staff_creation', { p_username: input.username, p_role_id: input.role_id })
  if (prep.error) return { ok: false, kind: mapRpcError(prep.error.message) }
  const prepared = interpretPrepare(prep.data, input.username)
  const email = prepared ? staffEmail(input.username, prepared.slug) : null
  if (!prepared || !email) return { ok: false, kind: 'server_error' }
  // the PIN length depends on the role NAME (Cashier = 6 digits, others 4), looked up server-side from role_id;
  // checked BEFORE any Auth user exists. Weak-PIN rules were applied to the raw PIN at parse time.
  if (!pinLengthMatchesRole(input.pin, prepared.roleName)) return { ok: false, kind: 'invalid_pin_length' }

  // 3. the Auth identity (service role)
  const created = await admin.auth.admin.createUser({
    email,
    password: randomPassword(),
    email_confirm: true,
    app_metadata: { staff: true },
  })
  const userId = created.data?.user?.id
  if (created.error || !userId) return { ok: false, kind: 'server_error' }

  let profileCreated = false
  const rollback = async (): Promise<void> => {
    try {
      if (profileCreated) await admin.from('profiles').delete().eq('id', userId)
      await admin.auth.admin.deleteUser(userId)
    } catch {
      console.error('staff-create: rollback_failed') // fixed code only: the ids are not secrets but keep logs boring
    }
  }

  try {
    // 4. the profile row, as the caller (the DB binds email <-> tenant <-> username <-> role)
    const prof = await caller.rpc('fn_create_staff_profile', {
      p_auth_user_id: userId,
      p_first_name: input.first_name,
      p_middle_name: input.middle_name,
      p_last_name: input.last_name,
      p_username: input.username,
      p_role_id: input.role_id,
    })
    if (prof.error) {
      await rollback()
      return { ok: false, kind: mapRpcError(prof.error.message) }
    }
    profileCreated = true

    // 5. the PIN, peppered here; the DB never sees it
    const digest = await computePinDigest(input.pin, env.pinPepper)
    const pin = await admin.rpc('fn_set_user_pin', { p_profile_id: userId, p_pin_digest: digest, p_pin_length: pinLengthForRole(prepared.roleName) })
    if (pin.error) {
      await rollback()
      return { ok: false, kind: 'server_error' }
    }
    return { ok: true, profileId: userId }
  } catch {
    await rollback()
    return { ok: false, kind: 'server_error' }
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

  const text = await readLimitedBody(req)
  if (text === null) return respond(shapeFailure('payload_too_large'), origin)
  const parsed = parseStaffCreateBody(text)
  if (!parsed.ok) return respond(shapeFailure(parsed.error), origin)

  let shaped: ShapedResponse
  try {
    const out = await createStaff(token, parsed.value)
    shaped = out.ok ? (shapeSuccess(out.profileId) ?? shapeFailure('server_error')) : shapeFailure(out.kind)
  } catch {
    console.error('staff-create: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status >= 400) console.warn(`staff-create: denied status=${shaped.status}`)
  return respond(shaped, origin)
})
