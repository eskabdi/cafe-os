// tenant-logo (PUBLIC, no sign-in): the tenant's CURRENT logo for the sign-in page (owner decision 4, Phase 3B).
//   GET /functions/v1/tenant-logo?slug=<slug>  ->  200 { url: <signed URL, 10 min> | null, expires_in }
// The private tenant-branding bucket stays private: fn_tenant_logo_for_slug (service role) returns the current logo path of an
// accessible tenant only (not suspended / cancelled, object exists), and this function signs a short-lived URL for exactly that
// object. Unknown slug, no logo, suspended, cancelled, malformed request and any internal failure all answer the SAME
// 200 {url: null} (no enumeration oracle beyond what a public slug already is). Rate limited per IP. Nothing is logged.
//
// NOT EXECUTED here: Deno / Docker were unavailable when this was written. See README.md.
import { createClient } from '@supabase/supabase-js'
import { corsHeaders, parseAllowedOrigins, resolveAllowedOrigin } from '../_shared/cors.ts'
import { clientIp, createRateLimiter } from '../pin-login/logic.ts'
import {
  LOGO_URL_TTL_SEC,
  interpretLogoPath,
  isSignedUrlForProject,
  parseSlugParam,
  shapeLogo,
  shapeMethodNotAllowed,
  shapeRateLimited,
  type ShapedResponse,
} from './logic.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
const allowedOrigins = parseAllowedOrigins(Deno.env.get('ALLOWED_ORIGINS'))
const ipLimiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5, maxKeys: 10000 })
const admin =
  supabaseUrl && serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    : null

function respond(shaped: ShapedResponse, origin: string | null): Response {
  return new Response(JSON.stringify(shaped.body), { status: shaped.status, headers: { ...shaped.headers, ...corsHeaders(origin) } })
}

async function lookup(url: string): Promise<string | null> {
  if (!admin || !supabaseUrl) return null
  const slug = parseSlugParam(url)
  if (!slug) return null
  const res = await admin.rpc('fn_tenant_logo_for_slug', { p_slug: slug })
  if (res.error) return null
  const path = interpretLogoPath(res.data)
  if (!path) return null
  const signed = await admin.storage.from('tenant-branding').createSignedUrl(path, LOGO_URL_TTL_SEC)
  if (signed.error || !isSignedUrlForProject(signed.data?.signedUrl, supabaseUrl)) return null
  return signed.data.signedUrl
}

Deno.serve(async (req: Request): Promise<Response> => {
  const originHeader = req.headers.get('origin')
  const origin = resolveAllowedOrigin(originHeader, allowedOrigins)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) })
  if (req.method !== 'GET') return respond(shapeMethodNotAllowed(), origin)
  const ipDecision = ipLimiter.take(`ip:${clientIp(req.headers)}`)
  if (!ipDecision.allowed) return respond(shapeRateLimited(ipDecision.retryAfterSec), origin)
  let url: string | null = null
  try {
    url = await lookup(req.url)
  } catch {
    url = null
  }
  return respond(shapeLogo(url), origin)
})
