// Pure helpers for the two portals (execution prompt §34A): which portal an identity belongs to, usage-vs-quota bars,
// byte / date formatting with Arabic numerals, Ethiopian name order, and the permission-matrix model. Nothing here knows a
// role, station or category NAME: the only system identifiers are the two hardcoded system roles (CLAUDE.md).

export type Portal = 'platform' | 'tenant' | 'none'

/** Minimal shape of the server-derived session context this module reads. */
export interface PortalIdentity {
  user?: { id: string } | null
  restaurant?: { slug: string } | null
  platform_role?: string | null
  platform_mfa?: boolean | null
}

export const PLATFORM_SUPER_ADMIN = 'platform_super_admin'
export const TENANT_ADMIN_SYSTEM_KEY = 'tenant_admin'

/**
 * One account = one portal (the database enforces disjointness). A platform role wins over anything else so that a platform
 * admin can never render a tenant screen; a tenant identity needs a profile AND its restaurant.
 */
export function portalOf(ctx: PortalIdentity | null | undefined): Portal {
  if (!ctx) return 'none'
  if (ctx.platform_role) return 'platform'
  if (ctx.user && ctx.restaurant?.slug) return 'tenant'
  return 'none'
}

export function isPlatformSuperAdmin(ctx: PortalIdentity | null | undefined): boolean {
  return portalOf(ctx) === 'platform' && ctx?.platform_role === PLATFORM_SUPER_ADMIN
}

/**
 * The `aal` claim of an access token (UX only: decides whether to show the MFA gate before the first platform call; the
 * database re-checks aal2 + a live factor on every platform RPC). Anything unreadable is treated as aal1.
 */
export function tokenAal(accessToken: string | null | undefined): 'aal1' | 'aal2' {
  const part = accessToken?.split('.')[1]
  if (!part) return 'aal1'
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const payload: unknown = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
    return typeof payload === 'object' && payload !== null && (payload as { aal?: unknown }).aal === 'aal2' ? 'aal2' : 'aal1'
  } catch {
    return 'aal1'
  }
}

/** Platform portal opens only for an active Super Admin whose session is aal2 with a live factor (server-reported). */
export function platformMfaSatisfied(ctx: PortalIdentity | null | undefined, accessToken: string | null | undefined): boolean {
  return isPlatformSuperAdmin(ctx) && ctx?.platform_mfa === true && tokenAal(accessToken) === 'aal2'
}

/** The tenant_admin system role is identified by its system key / flag, never by its (editable) display name. */
export function isTenantAdminRole(role: { system_key?: string | null } | null | undefined): boolean {
  return role?.system_key === TENANT_ADMIN_SYSTEM_KEY
}

/** Any system role (is_system flag or a system key) is locked in the Tenant Portal editors. */
export function isSystemRole(role: { is_system?: boolean | null; system_key?: string | null }): boolean {
  return Boolean(role.is_system) || Boolean(role.system_key)
}

// ── names ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
type NameParts = {
  first_name: string
  middle_name?: string | null
  last_name?: string | null
}

/** Ethiopian full name: First + Middle (father) + Last (grandfather). */
export function fullName(p: NameParts): string {
  return [p.first_name, p.middle_name, p.last_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/** Short form: First + Middle. */
export function shortName(p: NameParts): string {
  return [p.first_name, p.middle_name]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

// ── numbers, bytes, dates (Arabic numerals only) ──────────────────────────────────────────────────────────────────────────
/** 12345 -> "12,345" (ASCII digits, never locale digits). */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const neg = n < 0
  const digits = String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${digits}`
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  let v = bytes
  let i = 0
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024
    i++
  }
  const shown = i === 0 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '')
  return `${shown} ${BYTE_UNITS[i]}`
}

const pad = (n: number) => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/** ISO timestamp -> "8 Oct 2026, 14:05" in the viewer's zone, ASCII digits only. Invalid input -> "—". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** ISO date or timestamp -> "8 Oct 2026". A bare YYYY-MM-DD is read as a calendar date (no zone shift). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? '?'} ${m[1]}`
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** Age in hours -> "3.5 h" / "2 d 4 h". */
export function formatAgeHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—'
  if (hours < 48) return `${Math.round(hours * 10) / 10} h`
  const d = Math.floor(hours / 24)
  return `${d} d ${Math.round(hours - d * 24)} h`
}

// ── usage vs quota ────────────────────────────────────────────────────────────────────────────────────────────────────────
export type UsageMetric = 'staff' | 'menu_items' | 'stations' | 'kiosks' | 'storage' | 'orders'

export interface UsageRow {
  metric: UsageMetric
  label: string
  used: number
  limit: number | null
  /** 0..100 (capped) or null for unlimited. */
  percent: number | null
  over: boolean
  format: 'count' | 'bytes'
}

/** The metric -> (usage key, limit key) pairs reported by fn_tenant_usage (same order as the server's over_quota list). */
export const USAGE_METRICS: ReadonlyArray<{
  metric: UsageMetric
  label: string
  used: string
  limit: string
  format: 'count' | 'bytes'
}> = [
  { metric: 'staff', label: 'Active staff', used: 'active_staff', limit: 'max_staff', format: 'count' },
  { metric: 'menu_items', label: 'Active menu items', used: 'menu_items', limit: 'max_menu_items', format: 'count' },
  { metric: 'stations', label: 'Active stations', used: 'stations', limit: 'max_stations', format: 'count' },
  { metric: 'kiosks', label: 'Registered terminals', used: 'kiosks', limit: 'max_kiosks', format: 'count' },
  { metric: 'storage', label: 'File storage', used: 'storage_bytes', limit: 'max_storage_bytes', format: 'bytes' },
  { metric: 'orders', label: 'Orders this month', used: 'orders_this_month', limit: 'max_orders_per_month', format: 'count' },
]

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Builds the usage bars. `overQuota` (server list) wins for the red state; the percentage is display only. */
export function usageRows(
  usage: Record<string, unknown>,
  limits: Record<string, unknown>,
  overQuota: readonly string[] = [],
): UsageRow[] {
  return USAGE_METRICS.map((m) => {
    const used = num(usage[m.used]) ?? 0
    const limit = num(limits[m.limit])
    const percent = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null
    return {
      metric: m.metric,
      label: m.label,
      used,
      limit,
      percent,
      over: overQuota.includes(m.metric) || (limit !== null && used > limit),
      format: m.format,
    }
  })
}

// ── permission matrix ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PermissionDef {
  key: string
  module: string
  description: string
  sort_order: number
}

/** Groups catalogue permissions by module, keeping the catalogue order (sort_order, then key). */
export function groupPermissions(perms: readonly PermissionDef[]): Array<{ module: string; items: PermissionDef[] }> {
  const sorted = [...perms].sort((a, b) => a.sort_order - b.sort_order || a.key.localeCompare(b.key))
  const out: Array<{ module: string; items: PermissionDef[] }> = []
  for (const p of sorted) {
    const g = out.find((x) => x.module === p.module)
    if (g) g.items.push(p)
    else out.push({ module: p.module, items: [p] })
  }
  return out
}

/** Sorted, de-duplicated key list (the payload of fn_update_role_permissions). */
export function normalizeKeys(keys: Iterable<string>): string[] {
  return [...new Set(keys)].sort()
}

export function sameKeySet(a: Iterable<string>, b: Iterable<string>): boolean {
  const x = normalizeKeys(a)
  const y = normalizeKeys(b)
  return x.length === y.length && x.every((k, i) => k === y[i])
}

/** What a draft adds and removes relative to the saved keys. */
export function diffKeys(saved: Iterable<string>, draft: Iterable<string>): { added: string[]; removed: string[] } {
  const s = new Set(saved)
  const d = new Set(draft)
  return {
    added: normalizeKeys([...d].filter((k) => !s.has(k))),
    removed: normalizeKeys([...s].filter((k) => !d.has(k))),
  }
}

/**
 * Columns the matrix may edit for this caller: never a system role (tenant_admin is locked), never the caller's own role
 * (no self-escalation; the server answers permission_denied), and for a non-tenant_admin caller only roles whose keys it
 * already holds (the server answers permission_escalation otherwise). UX only.
 */
export function canEditRoleColumn(
  role: { id: string; is_system?: boolean | null; system_key?: string | null; permission_keys: readonly string[] },
  caller: { roleId: string | null | undefined; isTenantAdmin: boolean; can: (p: string) => boolean },
): { editable: boolean; reason: 'system' | 'own_role' | 'covers' | null } {
  if (isSystemRole(role)) return { editable: false, reason: 'system' }
  if (caller.roleId && role.id === caller.roleId) return { editable: false, reason: 'own_role' }
  if (!caller.isTenantAdmin && !role.permission_keys.every((k) => caller.can(k))) {
    return { editable: false, reason: 'covers' }
  }
  return { editable: true, reason: null }
}

// ── validation shared by forms ────────────────────────────────────────────────────────────────────────────────────────────
/** Same slug rule as fn_platform_create_tenant (reserved words are checked by the server). */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('--')
}

export const STRICT_HEX_RE = /^#[0-9a-fA-F]{6}$/
export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/
export const ICON_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

// ── tenant logo (bucket tenant-branding, migration 0031) ───────────────────────────────────────────────────────────────────
/** Same limits as the tenant-branding bucket (1 MiB, png / jpeg / webp; no SVG: script-capable). The bucket and RPC re-check. */
export const LOGO_MAX_BYTES = 1024 * 1024
const LOGO_TYPES: ReadonlyArray<{ type: string; ext: string }> = [
  { type: 'image/png', ext: 'png' },
  { type: 'image/jpeg', ext: 'jpg' },
  { type: 'image/webp', ext: 'webp' },
]

export type LogoCheck = { ok: true; ext: string; contentType: string } | { ok: false; reason: 'type' | 'size' | 'empty' }

export function checkLogoFile(file: { type: string; size: number }): LogoCheck {
  if (file.size === 0) return { ok: false, reason: 'empty' }
  const t = LOGO_TYPES.find((x) => x.type === file.type)
  if (!t) return { ok: false, reason: 'type' }
  if (file.size > LOGO_MAX_BYTES) return { ok: false, reason: 'size' }
  return { ok: true, ext: t.ext, contentType: t.type }
}

/** `restaurants/<own id>/branding/<random>.<ext>` (the Storage policies and fn_update_restaurant_branding re-check it). */
export function logoObjectPath(restaurantId: string, ext: string, random: string = crypto.randomUUID()): string {
  return `restaurants/${restaurantId}/branding/${random}.${ext}`
}

// ── plan features (jsonb object of simple values) ───────────────────────────────────────────────────────────────────────
export type FeatureValue = boolean | number | string
const FEATURE_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/** One "key = value" per line; true/false and plain numbers are typed, anything else is a string (≤100). Null on error. */
export function parseFeatures(text: string): Record<string, FeatureValue> | null {
  const out: Record<string, FeatureValue> = {}
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length > 50) return null
  for (const line of lines) {
    const i = line.indexOf('=')
    if (i < 1) return null
    const key = line.slice(0, i).trim()
    const raw = line.slice(i + 1).trim()
    if (!FEATURE_KEY_RE.test(key) || Object.prototype.hasOwnProperty.call(out, key)) return null
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true'
    else if (/^-?\d{1,12}(?:\.\d{1,6})?$/.test(raw)) out[key] = Number(raw)
    else if (raw.length >= 1 && raw.length <= 100) out[key] = raw
    else return null
  }
  return out
}

export function formatFeatures(f: Record<string, unknown> | null | undefined): string {
  if (!f) return ''
  return Object.entries(f)
    .filter(([, v]) => typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string')
    .map(([k, v]) => `${k} = ${String(v)}`)
    .join('\n')
}

export const MIB = 1024 * 1024

/** Parses "Limit" inputs: empty = unlimited (null); else a positive whole number, or undefined when invalid. */
export function parseLimit(raw: string, max = 2147483647): number | null | undefined {
  const t = raw.trim()
  if (t === '') return null
  if (!/^\d{1,13}$/.test(t)) return undefined
  const n = Number(t)
  return n >= 1 && n <= max ? n : undefined
}

/** Parses "active_users:3" / "users:5" (role_in_use detail) into a count. */
export function roleInUseCount(detail: string | undefined): { kind: 'active_users' | 'users'; count: number } | null {
  const m = /^(active_users|users):(\d{1,9})$/.exec(detail ?? '')
  if (!m) return null
  return { kind: m[1] as 'active_users' | 'users', count: Number(m[2]) }
}
