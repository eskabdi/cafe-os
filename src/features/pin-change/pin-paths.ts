import type { PinChangeStatus } from '@/lib/domain/pin-change'

// Paths are built from the identity's own tenant slug (session context), never from the URL slug.
export const tenantHomePath = (slug: string) => `/r/${slug}`
export const changePinPath = (slug: string) => `/r/${slug}/change-pin`
export const pinPendingPath = (slug: string) => `/r/${slug}/pin-pending`
export const pinApprovalsPath = (slug: string) => `/r/${slug}/settings/pin-approvals`
export const sessionTimersPath = (slug: string) => `/r/${slug}/settings/session-timers`

/** TanStack Query key of the pending-approvals list (invalidated by the notifications listener and after decisions). */
export const PIN_APPROVALS_KEY = ['pin-approvals'] as const

/** Navigation state set when a pending change was rejected (the Change PIN screen explains it neutrally). */
export interface PinGateState {
  pinChangeRejected?: boolean
}

/**
 * Where the forced-PIN-change gate sends the user, or null to render the requested route. UX only: while the status is not
 * 'none' the database already denies every permission-checked RPC and RLS read for this user.
 *   required          -> Change PIN screen (from every tenant route)
 *   pending_approval  -> Waiting for approval screen
 *   none              -> the two forced screens bounce to the tenant home; everything else renders
 */
export function pinGateTarget(status: PinChangeStatus, pathname: string, slug: string): string | null {
  const path = pathname.replace(/\/+$/, '')
  const change = changePinPath(slug)
  const pending = pinPendingPath(slug)
  if (status === 'required') return path === change ? null : change
  if (status === 'pending_approval') return path === pending ? null : pending
  return /\/(change-pin|pin-pending)$/.test(path) ? tenantHomePath(slug) : null
}
