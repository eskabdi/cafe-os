// pin-login: PIN sign-in for NON-ADMIN staff only (profiles.auth_method = 'pin').
//
// Session minting approach (and why)
// ----------------------------------
// Staff have a Supabase Auth identity with a synthetic, non-routable email (*.staff.cafeos.invalid)
// and no usable password. After the DB verifies the PIN, this function:
//   1. calls auth.admin.generateLink({ type: 'magiclink', email }) with the service-role client. No email is
//      sent; the result contains a single-use hashed_token (kept server-side, never returned);
//   2. immediately redeems it with auth.verifyOtp({ type: 'email', token_hash }) using a SEPARATE
//      anon-key client with persistence disabled, which yields a normal GoTrue session
//      (access_token + refresh_token, standard expiry, refresh rotation);
//   3. returns ONLY { access_token, refresh_token, expires_in }.
// Why not sign a JWT ourselves: that needs the project JWT secret in function env (a reusable secret that
// can mint any identity) and bypasses GoTrue's refresh rotation / revocation. Why not set a password:
// it would create a reusable credential. The magic-link token is single-use and never leaves the function.
// The service-role key stays inside this function's environment; it is never returned or logged.
//
// PEPPER: PINs are never sent to the database; see _shared/pin.ts and README (PIN_PEPPER).
//
// Authority: tenant/user/PIN checks and lockout live in the DB (fn_verify_pin, which also registers
// failures itself, so this function must NOT call fn_register_pin_failure again: that would double count).
// The in-memory throttling here is defense in depth only.
//
// Known gap: the active-session check and the minting are two steps, so two simultaneous correct-PIN logins can both pass it.
// A second sign-in later is blocked; see docs/architecture/auth-flows.md (residual risk).
//
// NOT EXECUTED in CI here: Deno was unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readPinLoginEnv } from '../_shared/env.ts'
import { originSlugMatches } from '../_shared/host.ts'
import { kioskTokenHash } from '../_shared/kiosk.ts'
import {
  MAX_BODY_BYTES,
  checkRateLimits,
  computePinDigest,
  clientIp,
  createPinLoginLimiters,
  interpretVerifyResult,
  isPinCandidate,
  sessionGate,
  failureForBlockedLogin,
  isSyntheticStaffEmail,
  parsePinLoginBody,
  remainingDelayMs,
  shapeFailure,
  shapeSuccess,
  type FailureKind,
  type AnyLoginInput,
  isTileLogin,
  type ShapedResponse,
} from './logic.ts'

const env = readPinLoginEnv()
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
const limiters = createPinLoginLimiters()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), {
    status: shaped.status,
    headers: { ...shaped.headers, ...corsHeaders(origin) },
  })
}

/** Reads at most MAX_BODY_BYTES; returns null when the body is larger. */
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

type Outcome = { ok: true; session: unknown } | { ok: false; kind: FailureKind }

async function authenticate(input: AnyLoginInput): Promise<Outcome> {
  if (!env) return { ok: false, kind: 'server_error' }
  const authOpts = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, authOpts)

  // 1. tenant by slug, server-side (never trusted from the client beyond this lookup)
  //    (the anon resolver no longer returns the id, so the service role reads it; suspended/cancelled => null)
  const tenantRes = await admin
    .from('restaurants')
    .select('id')
    .eq('slug', input.restaurant_slug)
    .not('status', 'in', '(suspended,cancelled)')
    .maybeSingle()
  if (tenantRes.error) return { ok: false, kind: 'server_error' }
  const tenantId = (tenantRes.data as { id?: unknown } | null)?.id
  const tenant = typeof tenantId === 'string' ? tenantId : null

  // 2. the candidate profile
  //    username path: looked up by (tenant, username); any PIN user on any device (the 6-digit Cashier uses this path)
  //    tile path:     a REGISTERED KIOSK (token hash + slug, validated by the DB: unknown / revoked / wrong tenant /
  //                   suspended all answer false) and a profile that is an eligible 4-digit non-admin PIN tile of that tenant
  let candidate: boolean
  let profileId: string
  if (isTileLogin(input)) {
    const elig = await admin.rpc('fn_kiosk_tile_eligible', {
      p_token_hash: await kioskTokenHash(input.kiosk_token),
      p_slug: input.restaurant_slug,
      p_profile_id: input.profile_id,
    })
    if (elig.error) return { ok: false, kind: 'server_error' }
    candidate = tenant !== null && elig.data === true
    profileId = candidate ? input.profile_id : crypto.randomUUID()
  } else {
    let profile: unknown = null
    if (tenant) {
      const p = await admin
        .from('profiles')
        .select('id, restaurant_id, auth_method, is_active')
        .eq('restaurant_id', tenant)
        .eq('username', input.username)
        .maybeSingle()
      if (p.error) return { ok: false, kind: 'server_error' }
      profile = p.data
    }
    candidate = tenant !== null && isPinCandidate(profile, tenant)
    profileId = candidate ? (profile as { id: string }).id : crypto.randomUUID()
  }

  // 3. ALWAYS run fn_verify_pin so unknown tenant / unknown user / admin / inactive / bad kiosk cost the same.
  //    Non-candidates get a random id; the DB burns an equivalent bcrypt and answers 'invalid'.
  //    The DB only ever receives HMAC-SHA256(pin, PIN_PEPPER); the raw PIN stays in this function.
  const digest = await computePinDigest(input.pin, env.pinPepper)
  const verify = await admin.rpc('fn_verify_pin', { p_profile_id: profileId, p_pin_digest: digest })
  if (verify.error) return { ok: false, kind: 'server_error' }
  if (!candidate || tenant === null) return { ok: false, kind: 'invalid_credentials' }
  const outcome = interpretVerifyResult(verify.data, { profileId, restaurantId: tenant })
  if (outcome.kind !== 'ok') return { ok: false, kind: 'invalid_credentials' }

  // 4. defense in depth: the auth identity must exist, be PIN-method and use the synthetic staff email
  const method = await admin.rpc('fn_user_auth_method', { p_user_id: outcome.profileId })
  if (method.error || method.data !== 'pin') return { ok: false, kind: 'invalid_credentials' }
  const user = await admin.auth.admin.getUserById(outcome.profileId)
  const email = user.data?.user?.email
  if (user.error || !isSyntheticStaffEmail(email)) return { ok: false, kind: 'invalid_credentials' }

  // 4b. ONE concurrent session per PIN staff member: a correct PIN while another session is active is refused with the exact
  //     answer of a wrong PIN (no oracle). The DB then notifies the user and the tenant admins, forces a PIN change and audits it.
  //     A failure of the notification must never change the answer, hence the try/catch and the ignored result.
  const active = await admin.rpc('fn_staff_has_active_session', { p_profile_id: outcome.profileId })
  const gate = sessionGate(active.data, active.error)
  if (gate === 'error') return { ok: false, kind: 'server_error' }
  if (gate === 'blocked') {
    try {
      await admin.rpc('fn_staff_login_blocked', {
        p_profile_id: outcome.profileId,
        p_kiosk_token_hash: isTileLogin(input) ? await kioskTokenHash(input.kiosk_token) : null,
      })
    } catch {
      console.error('pin-login: blocked_notify_failed')
    }
    return { ok: false, kind: failureForBlockedLogin() }
  }

  // 5. mint the session (see header comment)
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = link.data?.properties?.hashed_token
  if (link.error || !tokenHash) return { ok: false, kind: 'server_error' }
  const anon = createClient(env.supabaseUrl, env.anonKey, authOpts)
  const redeemed = await anon.auth.verifyOtp({ type: 'email', token_hash: tokenHash })
  if (redeemed.error || !redeemed.data.session) return { ok: false, kind: 'server_error' }
  return { ok: true, session: redeemed.data.session }
}

Deno.serve(async (req: Request): Promise<Response> => {
  const startedAt = Date.now()
  const originHeader = req.headers.get('origin')
  const origin = resolveAllowedOrigin(originHeader, allowedOrigins)

  if (req.method === 'OPTIONS') {
    return origin
      ? new Response(null, { status: 204, headers: corsHeaders(origin) })
      : respond(shapeFailure('forbidden_origin'), null)
  }
  // A browser origin that is not allow-listed is refused outright (non-browser callers send no Origin).
  if (originHeader && !origin) return respond(shapeFailure('forbidden_origin'), null)
  if (req.method !== 'POST') return respond(shapeFailure('method_not_allowed'), origin)

  const text = await readLimitedBody(req)
  if (text === null) return respond(shapeFailure('payload_too_large'), origin)
  const parsed = parsePinLoginBody(text)
  if (!parsed.ok) return respond(shapeFailure('invalid_request'), origin)
  // a page served from <slug>.cafeos.et can only sign in to ITS tenant (same generic answer as a wrong PIN)
  if (!originSlugMatches(originHeader, parsed.value.restaurant_slug)) return respond(shapeFailure('invalid_credentials'), origin)

  const limit = checkRateLimits(limiters, clientIp(req.headers), parsed.value)
  if (!limit.allowed) return respond(shapeFailure('rate_limited', limit.retryAfterSec), origin)

  let shaped: ShapedResponse
  try {
    const out = await authenticate(parsed.value)
    shaped = out.ok ? (shapeSuccess(out.session) ?? shapeFailure('server_error')) : shapeFailure(out.kind)
  } catch {
    // Never log the error object: it could carry request data. Log a fixed code only.
    console.error('pin-login: unexpected_error')
    shaped = shapeFailure('server_error')
  }
  if (shaped.status !== 200) console.warn(`pin-login: denied status=${shaped.status}`)

  await sleep(remainingDelayMs(startedAt, Date.now()))
  return respond(shaped, origin)
})
