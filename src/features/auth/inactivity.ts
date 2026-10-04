// Inactivity sign-out policy for signed-in staff sessions. Constants live here (one place) so they can become per-tenant
// settings later. Total time to sign-out = IDLE_MS + WARN_MS.

/** No activity for this long shows the "Still there?" warning. */
export const IDLE_MS = 30_000
/** Time the warning is shown before the session is ended. */
export const WARN_MS = 30_000

export interface InactivityTimings {
  idleMs: number
  warnMs: number
}

declare global {
  interface Window {
    /** DEV/test only: shortens the timings for Playwright. Ignored (and dead-code-eliminated) in production builds. */
    __CAFEOS_INACTIVITY__?: Partial<InactivityTimings>
  }
}

export function inactivityTimings(): InactivityTimings {
  const base = { idleMs: IDLE_MS, warnMs: WARN_MS }
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const o = window.__CAFEOS_INACTIVITY__
    const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 200
    if (o)
      return { idleMs: ok(o.idleMs) ? o.idleMs : base.idleMs, warnMs: ok(o.warnMs) ? o.warnMs : base.warnMs }
  }
  return base
}

export type IdlePhase = 'active' | 'warning' | 'expired'

/** Pure, clock-based: a sleeping device that wakes after the deadline is 'expired' at once. */
export function idlePhase(elapsedMs: number, t: InactivityTimings): IdlePhase {
  if (elapsedMs >= t.idleMs + t.warnMs) return 'expired'
  return elapsedMs >= t.idleMs ? 'warning' : 'active'
}

/**
 * Who is subject to the policy: signed-in tenant sessions whose role is NOT the hardcoded tenant_admin system role,
 * and not platform admins. Decided from the server-derived session context (role.system_key), never from a role name.
 */
export function isInactivityManaged(
  ctx: {
    platform_role?: string
    role?: { system_key?: string | null }
    user?: unknown
  } | null,
): boolean {
  if (!ctx || ctx.platform_role || !ctx.user || !ctx.role) return false
  return ctx.role.system_key !== 'tenant_admin'
}
