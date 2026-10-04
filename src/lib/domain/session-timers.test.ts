import { describe, expect, it } from 'vitest'
import { inactivityMsFromTimers, pinPadIdleMs, sessionTimersFormSchema } from './session-timers'

describe('inactivityMsFromTimers', () => {
  it('maps warn / signout seconds to idle and warning durations', () => {
    expect(inactivityMsFromTimers({ idle_warning_seconds: 15, signout_seconds: 30 })).toEqual({
      idleMs: 15_000,
      warnMs: 15_000,
    })
    expect(inactivityMsFromTimers({ idle_warning_seconds: 60, signout_seconds: 300 })).toEqual({
      idleMs: 60_000,
      warnMs: 240_000,
    })
  })

  it('falls back to 15 / 30 when a field is missing or not a number', () => {
    const d = { idleMs: 15_000, warnMs: 15_000 }
    expect(inactivityMsFromTimers(undefined)).toEqual(d)
    expect(inactivityMsFromTimers(null)).toEqual(d)
    expect(inactivityMsFromTimers({ idle_warning_seconds: 60 })).toEqual(d)
    expect(inactivityMsFromTimers({ signout_seconds: 120 })).toEqual(d)
    expect(inactivityMsFromTimers({ idle_warning_seconds: Number.NaN, signout_seconds: 120 })).toEqual(d)
  })

  it('clamps to the bounds and keeps the warning before the sign-out', () => {
    expect(inactivityMsFromTimers({ idle_warning_seconds: 1, signout_seconds: 5 })).toEqual({
      idleMs: 5_000,
      warnMs: 10_000,
    })
    expect(inactivityMsFromTimers({ idle_warning_seconds: 2000, signout_seconds: 5000 })).toEqual({
      idleMs: 899_000,
      warnMs: 1_000,
    })
    expect(inactivityMsFromTimers({ idle_warning_seconds: 40, signout_seconds: 30 })).toEqual({
      idleMs: 29_000,
      warnMs: 1_000,
    })
  })
})

describe('pinPadIdleMs', () => {
  it('clamps to 15..300 s and defaults to 60 s', () => {
    expect(pinPadIdleMs(90)).toBe(90_000)
    expect(pinPadIdleMs(1)).toBe(15_000)
    expect(pinPadIdleMs(10_000)).toBe(300_000)
    expect(pinPadIdleMs(undefined)).toBe(60_000)
    expect(pinPadIdleMs(null)).toBe(60_000)
    expect(pinPadIdleMs('90')).toBe(60_000)
  })
})

describe('sessionTimersFormSchema', () => {
  const ok = { idle_warning_seconds: 15, signout_seconds: 30, pin_pad_idle_seconds: 60 }
  const firstIssue = (v: unknown) => {
    const r = sessionTimersFormSchema.safeParse(v)
    return r.success ? null : { path: r.error.issues[0]?.path.join('.'), message: r.error.issues[0]?.message }
  }

  it('accepts the defaults and the bounds', () => {
    expect(firstIssue(ok)).toBeNull()
    expect(firstIssue({ idle_warning_seconds: 5, signout_seconds: 15, pin_pad_idle_seconds: 15 })).toBeNull()
    expect(
      firstIssue({ idle_warning_seconds: 899, signout_seconds: 900, pin_pad_idle_seconds: 300 }),
    ).toBeNull()
  })

  it('mirrors the server rules', () => {
    expect(firstIssue({ ...ok, idle_warning_seconds: 4 })?.path).toBe('idle_warning_seconds')
    expect(firstIssue({ ...ok, idle_warning_seconds: 30 })).toEqual({
      path: 'idle_warning_seconds',
      message: 'The warning must appear before the sign-out time.',
    })
    expect(firstIssue({ ...ok, signout_seconds: 14, idle_warning_seconds: 5 })?.path).toBe('signout_seconds')
    expect(firstIssue({ ...ok, signout_seconds: 901 })?.path).toBe('signout_seconds')
    expect(firstIssue({ ...ok, pin_pad_idle_seconds: 14 })?.path).toBe('pin_pad_idle_seconds')
    expect(firstIssue({ ...ok, pin_pad_idle_seconds: 301 })?.path).toBe('pin_pad_idle_seconds')
    expect(firstIssue({ ...ok, signout_seconds: 30.5 })?.path).toBe('signout_seconds')
    expect(firstIssue({ ...ok, signout_seconds: Number.NaN })?.path).toBe('signout_seconds')
  })
})
