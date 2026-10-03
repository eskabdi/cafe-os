// Pure logic for the pin-login Edge Function: validation, throttling, response shaping.
// No Deno-only imports and no I/O, so Vitest can import this file directly.
// Never log or echo a PIN or token from here.

export const MAX_BODY_BYTES = 1024
export const MIN_RESPONSE_MS = 450
export const RESPONSE_JITTER_MS = 100
/** Synthetic, non-routable identity domain for PIN staff (enforced in the DB by a trigger). */
export const STAFF_EMAIL_SUFFIX = '.staff.cafeos.invalid'

// ── validation ──────────────────────────────────────────────────────────────
// Mirrors restaurants_slug_format, profiles.username check and the 4-6 digit PIN rule.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
const PIN_RE = /^[0-9]{4,6}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ALLOWED_KEYS = ['restaurant_slug', 'username', 'pin'] as const

export interface PinLoginInput {
  restaurant_slug: string
  username: string
  pin: string
}

export type ParseResult = { ok: true; value: PinLoginInput } | { ok: false; error: 'invalid_request' }

/** Strict parse of the raw request text: exact key set, string types, normalized slug/username. */
export function parsePinLoginBody(text: string): ParseResult {
  const fail: ParseResult = { ok: false, error: 'invalid_request' }
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return fail
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== ALLOWED_KEYS.length || !ALLOWED_KEYS.every((k) => keys.includes(k))) return fail
  const { restaurant_slug, username, pin } = obj
  if (typeof restaurant_slug !== 'string' || typeof username !== 'string' || typeof pin !== 'string') return fail
  const slug = restaurant_slug.trim().toLowerCase()
  const user = username.trim().toLowerCase()
  if (slug.includes('--') || !SLUG_RE.test(slug) || !USERNAME_RE.test(user) || !PIN_RE.test(pin)) return fail
  return { ok: true, value: { restaurant_slug: slug, username: user, pin } }
}

export function isSyntheticStaffEmail(email: unknown): email is string {
  return typeof email === 'string' && email.length <= 254 && email.toLowerCase().endsWith(STAFF_EMAIL_SUFFIX)
}

// ── rate limiting (defense in depth; the DB lockout in fn_verify_pin is authoritative) ──
export interface LimiterConfig {
  capacity: number
  refillPerSec: number
  maxKeys: number
}
export interface LimiterDecision {
  allowed: boolean
  retryAfterSec: number
}
export interface RateLimiter {
  take(key: string): LimiterDecision
  size(): number
}

/** In-memory token bucket with bounded memory (LRU eviction). Per-isolate only, so it is best effort. */
export function createRateLimiter(cfg: LimiterConfig, now: () => number = Date.now): RateLimiter {
  const buckets = new Map<string, { tokens: number; updated: number }>()
  return {
    take(key) {
      const t = now()
      const prev = buckets.get(key)
      let tokens = cfg.capacity
      if (prev) {
        tokens = Math.min(cfg.capacity, prev.tokens + ((t - prev.updated) / 1000) * cfg.refillPerSec)
        buckets.delete(key) // re-insert below to keep Map order = recency
      } else if (buckets.size >= cfg.maxKeys) {
        const oldest = buckets.keys().next()
        if (!oldest.done) buckets.delete(oldest.value)
      }
      if (tokens >= 1) {
        buckets.set(key, { tokens: tokens - 1, updated: t })
        return { allowed: true, retryAfterSec: 0 }
      }
      buckets.set(key, { tokens, updated: t })
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / cfg.refillPerSec)) }
    },
    size: () => buckets.size,
  }
}

export const IP_LIMIT: LimiterConfig = { capacity: 20, refillPerSec: 0.2, maxKeys: 5000 }
export const USER_LIMIT: LimiterConfig = { capacity: 6, refillPerSec: 1 / 30, maxKeys: 5000 }

export interface PinLoginLimiters {
  ip: RateLimiter
  user: RateLimiter
}
export function createPinLoginLimiters(now: () => number = Date.now): PinLoginLimiters {
  return { ip: createRateLimiter(IP_LIMIT, now), user: createRateLimiter(USER_LIMIT, now) }
}

/** Per-IP first, then per-(tenant, username). Keys are built from already-validated input. */
export function checkRateLimits(l: PinLoginLimiters, ip: string, input: PinLoginInput): LimiterDecision {
  const a = l.ip.take(`ip:${ip}`)
  if (!a.allowed) return a
  return l.user.take(`u:${input.restaurant_slug}:${input.username}`)
}

/** Best-effort client IP from proxy headers. Spoofable, hence only a throttling hint. */
export function clientIp(headers: { get(name: string): string | null }): string {
  const v =
    headers.get('x-real-ip') ?? headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0] ?? ''
  const ip = v.trim().slice(0, 64)
  return ip || 'unknown'
}

// ── verification result interpretation ──────────────────────────────────────
export type VerifyOutcome =
  | { kind: 'ok'; profileId: string; restaurantId: string }
  | { kind: 'denied' }

/**
 * Collapses fn_verify_pin's status object. Anything that is not a well-formed 'ok' for the profile and
 * tenant we asked about (invalid, locked, inactive, malformed, mismatching ids) is the same 'denied'.
 * attempts_left / locked_until from the DB are deliberately dropped.
 */
export function interpretVerifyResult(result: unknown, expected: { profileId: string; restaurantId: string }): VerifyOutcome {
  const denied: VerifyOutcome = { kind: 'denied' }
  if (typeof result !== 'object' || result === null) return denied
  const r = result as { status?: unknown; profile?: unknown }
  if (r.status !== 'ok' || typeof r.profile !== 'object' || r.profile === null) return denied
  const p = r.profile as { id?: unknown; restaurant_id?: unknown }
  if (typeof p.id !== 'string' || typeof p.restaurant_id !== 'string') return denied
  if (!UUID_RE.test(p.id) || p.id !== expected.profileId || p.restaurant_id !== expected.restaurantId) return denied
  return { kind: 'ok', profileId: p.id, restaurantId: p.restaurant_id }
}

/**
 * Whether the looked-up profile may even attempt PIN login. Anything else (admin, password method,
 * inactive, wrong tenant) is replaced by a random id so the same DB work runs and the answer is identical.
 */
export function isPinCandidate(profile: unknown, tenantId: string): profile is { id: string; restaurant_id: string } {
  if (typeof profile !== 'object' || profile === null) return false
  const p = profile as { id?: unknown; restaurant_id?: unknown; auth_method?: unknown; is_active?: unknown }
  return (
    typeof p.id === 'string' &&
    UUID_RE.test(p.id) &&
    p.restaurant_id === tenantId &&
    p.auth_method === 'pin' &&
    p.is_active === true
  )
}

// ── response shaping ────────────────────────────────────────────────────────
export type FailureKind = 'invalid_request' | 'invalid_credentials' | 'rate_limited' | 'payload_too_large' | 'method_not_allowed' | 'forbidden_origin' | 'server_error'

export interface ShapedResponse {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json' }

/** One fixed body per failure kind. Unknown tenant/user, inactive, locked, admin and bad PIN all use invalid_credentials. */
export function shapeFailure(kind: FailureKind, retryAfterSec?: number): ShapedResponse {
  switch (kind) {
    case 'invalid_credentials':
      return { status: 401, body: { error: 'invalid_credentials' }, headers: { ...NO_STORE } }
    case 'rate_limited':
      return {
        status: 429,
        body: { error: 'try_later' },
        headers: { ...NO_STORE, 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec ?? 30))) },
      }
    case 'invalid_request':
      return { status: 400, body: { error: 'invalid_request' }, headers: { ...NO_STORE } }
    case 'payload_too_large':
      return { status: 413, body: { error: 'invalid_request' }, headers: { ...NO_STORE } }
    case 'method_not_allowed':
      return { status: 405, body: { error: 'invalid_request' }, headers: { ...NO_STORE, Allow: 'POST, OPTIONS' } }
    case 'forbidden_origin':
      return { status: 403, body: { error: 'forbidden' }, headers: { ...NO_STORE } }
    case 'server_error':
      return { status: 503, body: { error: 'server_error' }, headers: { ...NO_STORE } }
  }
}

export interface MintedSession {
  access_token: string
  refresh_token: string
  expires_in: number
}

/** Whitelist: the ONLY fields that may leave the function on success. Returns null if malformed. */
export function shapeSuccess(session: unknown): ShapedResponse | null {
  if (typeof session !== 'object' || session === null) return null
  const s = session as Record<string, unknown>
  if (typeof s.access_token !== 'string' || typeof s.refresh_token !== 'string') return null
  if (typeof s.expires_in !== 'number' || !Number.isFinite(s.expires_in) || s.expires_in <= 0) return null
  const body: MintedSession = {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: Math.floor(s.expires_in),
  }
  return { status: 200, body: { ...body }, headers: { ...NO_STORE } }
}

// ── timing ──────────────────────────────────────────────────────────────────
/** Milliseconds still to wait so every outcome takes about the same time (floor + jitter). */
export function remainingDelayMs(startedAt: number, nowMs: number, rand: () => number = Math.random): number {
  const target = MIN_RESPONSE_MS + Math.floor(rand() * RESPONSE_JITTER_MS)
  return Math.max(0, target - (nowMs - startedAt))
}
