// Pure navigation logic for the tenant shell. Nothing here knows a station, role or category NAME: modules are keyed by
// permission code (the same codes the server checks in RLS / RPCs) and stations by UUID. All of it is UX only.

import type { PinChangeStatus } from './pin-change'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** One entry of the static module catalogue. `permission` must be a real code from the permissions catalogue. */
export interface ModuleNavSpec {
  id: string
  label: string
  /** Path below `/r/<slug>/` (no leading slash). */
  segment: string
  permission: string
  group: 'operations' | 'management' | 'settings'
}

export type Can = (permission: string) => boolean

/** Modules the user may open, in catalogue order. A module whose permission is not held is omitted (not disabled). */
export function visibleModules<T extends ModuleNavSpec>(modules: readonly T[], can: Can): T[] {
  return modules.filter((m) => can(m.permission))
}

/** Groups visible modules, keeping catalogue order and dropping empty groups. */
export function groupModules<T extends ModuleNavSpec>(
  modules: readonly T[],
): Array<{ group: T['group']; items: T[] }> {
  const out: Array<{ group: T['group']; items: T[] }> = []
  for (const m of modules) {
    const bucket = out.find((g) => g.group === m.group)
    if (bucket) bucket.items.push(m)
    else out.push({ group: m.group, items: [m] })
  }
  return out
}

export type AccountLinkId = 'change-pin' | 'pin-approvals' | 'session-timers' | 'security'

/**
 * Account links and their visibility rules (unchanged from the Phase 1 header):
 *  - Change PIN while the server reports pin_change_status = 'required'
 *  - PIN approvals for users.manage, Session timers for settings.session_timers (only for an unrestricted user)
 *  - Security (authenticator) only for sessions that signed in with Supabase Auth, never for PIN sessions
 */
export function accountLinkIds(input: {
  status: PinChangeStatus
  can: Can
  supabaseAuthSession: boolean
}): AccountLinkId[] {
  const { status, can, supabaseAuthSession } = input
  const out: AccountLinkId[] = []
  if (status === 'required') out.push('change-pin')
  if (status !== 'none') return out
  if (can('users.manage')) out.push('pin-approvals')
  if (can('settings.session_timers')) out.push('session-timers')
  if (supabaseAuthSession) out.push('security')
  return out
}

/** Minimal station row shape the navigation needs (presentation comes from the row). */
export interface StationNavRow {
  id: string
  name: string
  color?: string | null
  icon?: string | null
  sort_order?: number | null
  is_active: boolean
}

/**
 * Permission the KDS reads need: order_items_select requires orders.view AND (orders.view_all OR station access OR own
 * order). Station access itself is role_station_access (tenant_admin: every station), reported as context.station_ids and
 * enforced in RLS through current_station_ids().
 */
export const STATION_BOARD_PERMISSION = 'orders.view'

/**
 * Stations shown in the navigation: active rows the user has station access to, ordered by sort_order then name.
 * Rows with a malformed id are dropped. Without the board permission no station is listed.
 */
export function visibleStations<T extends StationNavRow>(
  stations: readonly T[],
  access: { stationIds: readonly string[]; can: Can },
): T[] {
  if (!access.can(STATION_BOARD_PERMISSION)) return []
  const allowed = new Set(access.stationIds)
  return stations
    .filter((s) => s.is_active && isUuid(s.id) && allowed.has(s.id))
    .sort(
      (a, b) =>
        (a.sort_order ?? 0) - (b.sort_order ?? 0) ||
        a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
    )
}

/** May the user open the board of `stationId`? (UX only; RLS filters the station's tickets.) */
export function canOpenStation(
  stationId: string | undefined,
  access: { stationIds: readonly string[]; can: Can },
) {
  return isUuid(stationId) && access.can(STATION_BOARD_PERMISSION) && access.stationIds.includes(stationId)
}
