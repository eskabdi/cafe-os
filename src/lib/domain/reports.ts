import { z } from 'zod'
import { ethiopianClock, formatEthiopianDateTime } from './ethiopian-time'

// Pure presentation helpers for the dashboard and reports (Phase 8). No figure is computed here: every amount comes from
// fn_report / fn_dashboard. These helpers only validate the day-range input and label hours and days. Arabic numerals only.

/** The server refuses a range wider than this (fn_report: to - from <= 366). */
export const MAX_REPORT_SPAN_DAYS = 367

export type DayRange = { from: number | null; to: number | null }
export type DayRangeResult = { ok: true; range: DayRange } | { ok: false; error: string }

const DAY_NO = /^\d{1,6}$/

/** The range form (Zod): two optional day-number fields, refined to the server's invalid_input|day_range rule. */
export const dayRangeFormSchema = z
  .object({ from: z.string().trim(), to: z.string().trim() })
  .superRefine((v, ctx) => {
    if ((v.from !== '' && !DAY_NO.test(v.from)) || (v.to !== '' && !DAY_NO.test(v.to))) {
      ctx.addIssue({ code: 'custom', message: 'Enter business day numbers (digits only).' })
      return
    }
    if (v.from === '' && v.to === '') return
    const from = Number(v.from === '' ? v.to : v.from)
    const to = Number(v.to === '' ? v.from : v.to)
    if (from < 1 || to < 1) ctx.addIssue({ code: 'custom', message: 'Business day numbers start at 1.' })
    else if (to < from) ctx.addIssue({ code: 'custom', message: 'The last day must not be before the first day.' })
    else if (to - from >= MAX_REPORT_SPAN_DAYS) {
      ctx.addIssue({ code: 'custom', message: `A report covers at most ${MAX_REPORT_SPAN_DAYS} business days.` })
    }
  })
  .transform((v): DayRange => {
    if (v.from === '' && v.to === '') return { from: null, to: null }
    return { from: Number(v.from === '' ? v.to : v.from), to: Number(v.to === '' ? v.from : v.to) }
  })

/**
 * Parse the "from day" / "to day" inputs. Both empty = the current business day (null, null). One filled = that single day.
 * Mirrors the server's rule so the user gets the message before the round trip (UX only; the server re-validates).
 */
export function parseDayRange(fromText: string, toText: string): DayRangeResult {
  const r = dayRangeFormSchema.safeParse({ from: fromText, to: toText })
  if (r.success) return { ok: true, range: r.data }
  return { ok: false, error: r.error.issues[0]?.message ?? 'Invalid range.' }
}

/** "07:00" for a tenant-local hour 0..23. */
export function internationalHourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** "1:00 ጠዋት" (the Ethiopian clock) for a tenant-local hour 0..23. */
export function ethiopianHourLabel(hour: number): string {
  return ethiopianClock(hour, 0)
}

/** The hours that had activity (the chart shows all 24, the table only the non-empty ones). */
export function activeHours<T extends { orders: number }>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.orders > 0)
}

export interface ReportDay {
  day_no: number
  status: string
  opened_at: string
}

/** A one-line description of the covered business days, with the Ethiopian date of the first day's opening. */
export function describeDays(days: readonly ReportDay[], timeZone: string): string {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return 'No business day in this range.'
  const opened = formatEthiopianDateTime(first.opened_at, timeZone)
  if (days.length === 1) return `Business day ${first.day_no} (${first.status}), opened ${opened}`
  return `Business days ${first.day_no}–${last.day_no} (${days.length} days), from ${opened}`
}
