import { z } from 'zod'

// Per-tenant session timers (migration 0025). The database CHECKs and fn_update_session_timers are the authority; the bounds
// here only preview the same rules in the form and keep the client safe if the server ever sent something odd.

export interface SessionTimers {
  idle_warning_seconds: number
  signout_seconds: number
  pin_pad_idle_seconds: number
}

export const SESSION_TIMER_DEFAULTS: SessionTimers = {
  idle_warning_seconds: 15,
  signout_seconds: 30,
  pin_pad_idle_seconds: 60,
}

export const SESSION_TIMER_BOUNDS = {
  idle_warning_seconds: { min: 5 }, // and strictly below signout_seconds
  signout_seconds: { min: 15, max: 900 },
  pin_pad_idle_seconds: { min: 15, max: 300 },
} as const

export type SessionTimerField = keyof SessionTimers
export const SESSION_TIMER_FIELDS: readonly SessionTimerField[] = [
  'idle_warning_seconds',
  'signout_seconds',
  'pin_pad_idle_seconds',
]

const whole = (label: string) =>
  z.number({ invalid_type_error: `Enter ${label} in whole seconds.` }).int(`Enter ${label} in whole seconds.`)

/** Form schema (client preview of the server rules: 5 <= warn < signout; 15 <= signout <= 900; 15 <= pin pad <= 300). */
export const sessionTimersFormSchema = z
  .object({
    idle_warning_seconds: whole('the warning time').min(5, 'The warning must come after at least 5 seconds.'),
    signout_seconds: whole('the sign-out time')
      .min(15, 'Sign-out must be at least 15 seconds.')
      .max(900, 'Sign-out can be at most 900 seconds (15 minutes).'),
    pin_pad_idle_seconds: whole('the PIN pad time')
      .min(15, 'The PIN pad time must be at least 15 seconds.')
      .max(300, 'The PIN pad time can be at most 300 seconds (5 minutes).'),
  })
  .refine((v) => v.idle_warning_seconds < v.signout_seconds, {
    path: ['idle_warning_seconds'],
    message: 'The warning must appear before the sign-out time.',
  })

export type SessionTimersForm = z.infer<typeof sessionTimersFormSchema>

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/**
 * Inactivity timings for InactivityGuard from the server's session_timers: warning after idle_warning_seconds, sign-out at
 * signout_seconds in total (so the warning is visible for signout - warn seconds). Clamped to the bounds; if either field is
 * missing or not a number, BOTH fall back to the defaults (15 / 30) so a half value can never produce warn >= signout.
 */
export function inactivityMsFromTimers(
  timers: Partial<Pick<SessionTimers, 'idle_warning_seconds' | 'signout_seconds'>> | null | undefined,
): { idleMs: number; warnMs: number } {
  let warn = SESSION_TIMER_DEFAULTS.idle_warning_seconds
  let signout = SESSION_TIMER_DEFAULTS.signout_seconds
  if (timers && isWhole(timers.idle_warning_seconds) && isWhole(timers.signout_seconds)) {
    signout = clamp(Math.round(timers.signout_seconds), 15, 900)
    warn = clamp(Math.round(timers.idle_warning_seconds), 5, signout - 1)
  }
  return { idleMs: warn * 1000, warnMs: (signout - warn) * 1000 }
}

/** Kiosk PIN-pad idle time from the staff-roster response: clamped to 15..300 s, 60 s when missing or not a number. */
export function pinPadIdleMs(seconds: unknown): number {
  if (!isWhole(seconds)) return SESSION_TIMER_DEFAULTS.pin_pad_idle_seconds * 1000
  return clamp(Math.round(seconds), 15, 300) * 1000
}
