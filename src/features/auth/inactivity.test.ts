import { describe, expect, it } from 'vitest'
import { IDLE_MS, WARN_MS, idlePhase, inactivityTimings, isInactivityManaged } from './inactivity'

describe('inactivity policy', () => {
  it('totals 30 seconds: warning at 15s, sign-out at 30s', () => {
    expect(IDLE_MS).toBe(15_000)
    expect(WARN_MS).toBe(15_000)
    expect(IDLE_MS + WARN_MS).toBe(30_000)
  })

  it('derives the phase from elapsed wall-clock time (a long sleep is expired at once)', () => {
    const t = inactivityTimings()
    expect(idlePhase(0, t)).toBe('active')
    expect(idlePhase(14_999, t)).toBe('active')
    expect(idlePhase(15_000, t)).toBe('warning')
    expect(idlePhase(29_999, t)).toBe('warning')
    expect(idlePhase(30_000, t)).toBe('expired')
    expect(idlePhase(8 * 3_600_000, t)).toBe('expired')
  })

  it('exempts tenant_admin (system_key) and platform admins, nothing by name', () => {
    const user = { id: 'u' }
    expect(isInactivityManaged({ user, role: { system_key: null } })).toBe(true)
    expect(isInactivityManaged({ user, role: {} })).toBe(true)
    expect(isInactivityManaged({ user, role: { system_key: 'tenant_admin' } })).toBe(false)
    expect(
      isInactivityManaged({ user, role: { system_key: null }, platform_role: 'platform_super_admin' }),
    ).toBe(false)
    expect(isInactivityManaged(null)).toBe(false)
  })

  it('honours the DEV-only override with a floor, ignoring junk', () => {
    window.__CAFEOS_INACTIVITY__ = { idleMs: 1000, warnMs: 5 }
    expect(inactivityTimings()).toEqual({ idleMs: 1000, warnMs: WARN_MS })
    delete window.__CAFEOS_INACTIVITY__
    expect(inactivityTimings()).toEqual({ idleMs: IDLE_MS, warnMs: WARN_MS })
  })

  it('uses the tenant session_timers (warning for signout - warn seconds), the DEV override still wins', () => {
    expect(inactivityTimings({ idle_warning_seconds: 60, signout_seconds: 300 })).toEqual({
      idleMs: 60_000,
      warnMs: 240_000,
    })
    expect(inactivityTimings({ signout_seconds: 300 })).toEqual({ idleMs: IDLE_MS, warnMs: WARN_MS })
    window.__CAFEOS_INACTIVITY__ = { idleMs: 1000, warnMs: 1000 }
    expect(inactivityTimings({ idle_warning_seconds: 60, signout_seconds: 300 })).toEqual({
      idleMs: 1000,
      warnMs: 1000,
    })
    delete window.__CAFEOS_INACTIVITY__
  })
})
