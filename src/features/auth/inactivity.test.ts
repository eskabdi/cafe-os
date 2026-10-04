import { describe, expect, it } from 'vitest'
import { IDLE_MS, WARN_MS, idlePhase, inactivityTimings, isInactivityManaged } from './inactivity'

describe('inactivity policy', () => {
  it('totals one minute: warning at 30s, sign-out at 60s', () => {
    expect(IDLE_MS).toBe(30_000)
    expect(WARN_MS).toBe(30_000)
    expect(IDLE_MS + WARN_MS).toBe(60_000)
  })

  it('derives the phase from elapsed wall-clock time (a long sleep is expired at once)', () => {
    const t = inactivityTimings()
    expect(idlePhase(0, t)).toBe('active')
    expect(idlePhase(29_999, t)).toBe('active')
    expect(idlePhase(30_000, t)).toBe('warning')
    expect(idlePhase(59_999, t)).toBe('warning')
    expect(idlePhase(60_000, t)).toBe('expired')
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
})
