// staff-roster: the PIN-staff tiles for a REGISTERED kiosk device (shared floor terminal).
//
// POST { restaurant_slug, kiosk_token }  (the slug is derived from the page hostname <slug>.cafeos.et by the SPA).
// The service role asks the database (fn_kiosk_roster) to resolve sha256(token) -> kiosk (not revoked) -> tenant and to check
// that the tenant's slug equals the claimed one and the tenant is not suspended/cancelled. Every failure is the same 401.
// The roster contains ONLY active, non-admin PIN staff with a 4-digit PIN (the 6-digit Cashier and admins never appear):
// id, short name (first + middle), role label, colour, icon. Never username, email, secrets or permissions.
// Rate limited best effort, Cache-Control: no-store, X-Robots-Tag: noindex. Updates the kiosk's last_seen_at (throttled in SQL).
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { readRosterEnv } from '../_shared/env.ts'
import { originSlugMatches } from '../_shared/host.ts'
import { kioskTokenHash } from '../_shared/kiosk.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import { MAX_BODY_BYTES, parseRosterBody, shapeFailure, shapeSuccess, shapeTiles, type ShapedResponse } from './logic.ts'

const env = readRosterEnv()
const allowedOrigins = parseAllowedOrigins(env?.allowedOrigins)
// best effort per isolate: per IP, and per (IP, slug) so one device cannot hammer one tenant
const ipLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5, maxKeys: 5000 })
const pairLimiter = createRateLimiter({ capacity: 12, refillPerSec: 0.1, maxKeys: 5000 })

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

Deno.serve(async (req: Request): Promise<Response> => {
  const originHeader = req.headers.get('origin')
  const origin = resolveAllowedOrigin(originHeader, allowedOrigins)
  if (req.method === 'OPTIONS') {
    return origin ? new Response(null, { status: 204, headers: corsHeaders(origin) }) : respond(shapeFailure('forbidden_origin'), null)
  }
  if (originHeader && !origin) return respond(shapeFailure('forbidden_origin'), null)
  if (req.method !== 'POST') return respond(shapeFailure('method_not_allowed'), origin)

  const ip = clientIp(req.headers)
  const ipDecision = ipLimiter.take(`ip:${ip}`)
  if (!ipDecision.allowed) return respond(shapeFailure('rate_limited', ipDecision.retryAfterSec), origin)

  const text = await readLimitedBody(req)
  if (text === null) return respond(shapeFailure('payload_too_large'), origin)
  const parsed = parseRosterBody(text)
  if (!parsed.ok) return respond(shapeFailure('invalid_request'), origin)
  const { restaurant_slug, kiosk_token } = parsed.value
  const pairDecision = pairLimiter.take(`p:${ip}:${restaurant_slug}`)
  if (!pairDecision.allowed) return respond(shapeFailure('rate_limited', pairDecision.retryAfterSec), origin)
  // a page served from another tenant's subdomain cannot ask for this tenant's roster
  if (!originSlugMatches(originHeader, restaurant_slug)) return respond(shapeFailure('invalid_kiosk'), origin)
  if (!env) return respond(shapeFailure('server_error'), origin)

  let shaped: ShapedResponse
  try {
    const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const res = await admin.rpc('fn_kiosk_roster', { p_token_hash: await kioskTokenHash(kiosk_token), p_slug: restaurant_slug })
    if (res.error) {
      shaped = shapeFailure('server_error')
    } else {
      const tiles = shapeTiles(res.data)
      shaped = tiles === null ? shapeFailure('invalid_kiosk') : shapeSuccess(tiles)
    }
  } catch {
    console.error('staff-roster: unexpected_error') // fixed code only
    shaped = shapeFailure('server_error')
  }
  if (shaped.status !== 200) console.warn(`staff-roster: denied status=${shaped.status}`)
  return respond(shaped, origin)
})
