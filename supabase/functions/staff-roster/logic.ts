// Pure logic for the staff-roster Edge Function (the tiles shown on a REGISTERED kiosk). No Deno imports, no I/O.
// Never log or echo a kiosk token, its hash, a PIN or a username from here.
import { KIOSK_TOKEN_RE } from '../_shared/kiosk.ts'
import { SLUG_RE } from '../_shared/host.ts'

export const MAX_BODY_BYTES = 512

export interface RosterInput {
  restaurant_slug: string
  kiosk_token: string
}
export type ParseResult = { ok: true; value: RosterInput } | { ok: false }

/** Strict: exactly {restaurant_slug, kiosk_token}. The slug is the one derived from the page hostname by the SPA. */
export function parseRosterBody(text: string): ParseResult {
  if (text.length === 0 || text.length > MAX_BODY_BYTES) return { ok: false }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false }
  const obj = raw as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length !== 2 || !keys.includes('restaurant_slug') || !keys.includes('kiosk_token')) return { ok: false }
  const { restaurant_slug, kiosk_token } = obj
  if (typeof restaurant_slug !== 'string' || typeof kiosk_token !== 'string') return { ok: false }
  const slug = restaurant_slug.trim().toLowerCase()
  if (slug.includes('--') || !SLUG_RE.test(slug) || !KIOSK_TOKEN_RE.test(kiosk_token)) return { ok: false }
  return { ok: true, value: { restaurant_slug: slug, kiosk_token } }
}

export interface Tile {
  id: string
  name: string
  role: string
  color: string | null
  icon: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLOR_RE = /^#[0-9a-fA-F]{6}$/
const ICON_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * Whitelists what leaves the function: ONLY id, name, role, color, icon per tile, each re-validated; any other field the
 * database might ever add (username, email, secrets, permissions) is dropped. Returns null when the payload is not an array
 * (the DB answers NULL for an invalid kiosk).
 */
export function shapeTiles(data: unknown): Tile[] | null {
  if (!Array.isArray(data)) return null
  const out: Tile[] = []
  for (const t of data) {
    if (typeof t !== 'object' || t === null) continue
    const r = t as Record<string, unknown>
    if (typeof r.id !== 'string' || !UUID_RE.test(r.id) || typeof r.name !== 'string' || typeof r.role !== 'string') continue
    out.push({
      id: r.id.toLowerCase(),
      name: r.name.slice(0, 121),
      role: r.role.slice(0, 60),
      color: typeof r.color === 'string' && COLOR_RE.test(r.color) ? r.color : null,
      icon: typeof r.icon === 'string' && ICON_RE.test(r.icon) ? r.icon : null,
    })
  }
  return out
}

/**
 * PIN-pad idle timer (seconds without activity on the pad before the kiosk drops the PIN and returns to the tiles). Per tenant,
 * stored in public.restaurant_session_settings (migration 0025); the bounds mirror its CHECK (15..300) and the default mirrors its
 * column default (60). Anything that is not an integer inside the bounds (missing, string, float, NaN, out of range) is replaced by
 * the default: a malformed value can never disable or shorten the timer below the platform floor.
 */
export const PIN_PAD_IDLE_DEFAULT_SECONDS = 60
export const PIN_PAD_IDLE_MIN_SECONDS = 15
export const PIN_PAD_IDLE_MAX_SECONDS = 300

export function normalizePinPadIdleSeconds(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= PIN_PAD_IDLE_MIN_SECONDS && value <= PIN_PAD_IDLE_MAX_SECONDS
    ? value
    : PIN_PAD_IDLE_DEFAULT_SECONDS
}

export interface Roster {
  staff: Tile[]
  pin_pad_idle_seconds: number
}

/**
 * Shapes the answer of fn_kiosk_terminal_bootstrap: NULL (invalid kiosk) or {staff: [...], pin_pad_idle_seconds}.
 * Returns null unless the payload is an object whose `staff` is an array (=> 401 invalid_kiosk); the tiles go through the
 * shapeTiles whitelist and the timer through normalizePinPadIdleSeconds. Every other field is dropped.
 */
export function shapeRoster(data: unknown): Roster | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const r = data as Record<string, unknown>
  const staff = shapeTiles(r.staff)
  if (staff === null) return null
  return { staff, pin_pad_idle_seconds: normalizePinPadIdleSeconds(r.pin_pad_idle_seconds) }
}

export type FailureKind ='invalid_kiosk' | 'invalid_request' | 'rate_limited' | 'payload_too_large' | 'method_not_allowed' | 'forbidden_origin' | 'server_error'

export interface ShapedResponse {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

/** Never cacheable, never indexable (the roster is names of staff). */
export const PRIVATE_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
  'X-Robots-Tag': 'noindex, nofollow',
} as const

export function shapeFailure(kind: FailureKind, retryAfterSec?: number): ShapedResponse {
  const h = { ...PRIVATE_HEADERS } as Record<string, string>
  switch (kind) {
    // unknown / revoked / wrong tenant / suspended / cancelled / origin mismatch: one identical answer
    case 'invalid_kiosk':
    case 'forbidden_origin':
      return { status: 401, body: { error: 'invalid_kiosk' }, headers: h }
    case 'invalid_request':
      return { status: 400, body: { error: 'invalid_request' }, headers: h }
    case 'payload_too_large':
      return { status: 413, body: { error: 'invalid_request' }, headers: h }
    case 'method_not_allowed':
      return { status: 405, body: { error: 'invalid_request' }, headers: { ...h, Allow: 'POST, OPTIONS' } }
    case 'rate_limited':
      return { status: 429, body: { error: 'try_later' }, headers: { ...h, 'Retry-After': String(Math.max(1, Math.floor(retryAfterSec ?? 30))) } }
    case 'server_error':
      return { status: 503, body: { error: 'server_error' }, headers: h }
  }
}

export function shapeSuccess(roster: Roster): ShapedResponse {
  return {
    status: 200,
    body: { staff: roster.staff, pin_pad_idle_seconds: normalizePinPadIdleSeconds(roster.pin_pad_idle_seconds) },
    headers: { ...PRIVATE_HEADERS },
  }
}
