import { z } from 'zod'
import { ETHIOPIAN_MONTHS, gregorianToJdn, jdnToGregorian, toEthiopianDate } from './ethiopian-time'

// Report periods (Daily / Weekly / Monthly / Custom) as Gregorian calendar dates "YYYY-MM-DD", the shape fn_report_period
// takes. Pure: no clock, no time zone (the caller passes "today" in the tenant's zone). The month is the ETHIOPIAN month
// (13 months, Pagume 5 or 6 days); weeks run Monday to Sunday. Labels use Arabic numerals only (never Ge'ez numerals).

/** fn_report_period refuses a span wider than this many days (invalid_input|period). Inclusive day count. */
export const MAX_PERIOD_DAYS = 366

export type PeriodKind = 'daily' | 'weekly' | 'monthly' | 'custom'
export const PERIOD_KINDS: readonly PeriodKind[] = ['daily', 'weekly', 'monthly', 'custom']

export type Period =
  | { kind: 'daily'; date: string }
  | { kind: 'weekly'; date: string }
  | { kind: 'monthly'; year: number; month: number }
  | { kind: 'custom'; from: string; to: string }

export interface DateRange {
  from: string
  to: string
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// ── Julian day numbers (integer day arithmetic, no Date objects, no DST; shared with ethiopian-time.ts) ─────────────
function jdnToIso(jdn: number): string {
  const g = jdnToGregorian(jdn)
  return `${String(g.year).padStart(4, '0')}-${String(g.month).padStart(2, '0')}-${String(g.day).padStart(2, '0')}`
}

/** A real calendar date "YYYY-MM-DD" (rejects 2026-02-30). */
export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false
  return jdnToIso(gregorianToJdn(y, mo, d)) === s
}

function isoToJdn(s: string): number {
  const m = ISO_DATE.exec(s)
  if (!m) throw new Error('invalid date')
  return gregorianToJdn(Number(m[1]), Number(m[2]), Number(m[3]))
}

export function addDays(iso: string, days: number): string {
  return jdnToIso(isoToJdn(iso) + days)
}

/** Inclusive number of days from `from` to `to` (same day = 1). */
export function spanDays(from: string, to: string): number {
  return isoToJdn(to) - isoToJdn(from) + 1
}

// ── Ethiopian calendar ───────────────────────────────────────────────────────────────────────────────────────────────
/** Ethiopian leap year (Pagume has 6 days): the year before the Gregorian leap year's September, i.e. year % 4 === 3. */
export function isEthiopianLeapYear(year: number): boolean {
  return ((year % 4) + 4) % 4 === 3
}

export function ethiopianMonthLength(year: number, month: number): number {
  if (month === 13) return isEthiopianLeapYear(year) ? 6 : 5
  return 30
}

/** Ethiopian date (year, month 1..13, day) to the Gregorian "YYYY-MM-DD" (Amete Mihret epoch, JDN 1724221). */
export function ethiopianToIso(year: number, month: number, day: number): string {
  const jdn = 1724220 + 365 * (year - 1) + Math.floor(year / 4) + 30 * (month - 1) + day
  return jdnToIso(jdn)
}

/** The Gregorian from/to (inclusive) of an Ethiopian month, Pagume included (5 days, 6 in a leap year). */
export function ethiopianMonthRange(year: number, month: number): DateRange {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 13)
    throw new Error('invalid month')
  return {
    from: ethiopianToIso(year, month, 1),
    to: ethiopianToIso(year, month, ethiopianMonthLength(year, month)),
  }
}

export function isoToEthiopian(iso: string): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(iso)
  if (!m) throw new Error('invalid date')
  return toEthiopianDate(Number(m[1]), Number(m[2]), Number(m[3]))
}

/** The Ethiopian years the month picker accepts. */
export const MIN_ETH_YEAR = 1990
export const MAX_ETH_YEAR = 2100

/** A whole Ethiopian year in [MIN_ETH_YEAR, MAX_ETH_YEAR] from the year input's text (4 Arabic digits), else null. */
export function parseEthiopianYear(text: string): number | null {
  const t = text.trim()
  if (!/^\d{4}$/.test(t)) return null
  const y = Number(t)
  return y >= MIN_ETH_YEAR && y <= MAX_ETH_YEAR ? y : null
}

/** Next / previous Ethiopian month (Pagume is followed by Meskerem of the next year). */
export function shiftEthiopianMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 13 + (month - 1) + delta
  return { year: Math.floor(index / 13), month: (((index % 13) + 13) % 13) + 1 }
}

// ── Weeks ────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Monday..Sunday week containing the date. */
export function weekRange(iso: string): DateRange {
  const jdn = isoToJdn(iso)
  const monday = jdn - (jdn % 7) // JDN % 7 === 0 is a Monday
  return { from: jdnToIso(monday), to: jdnToIso(monday + 6) }
}

// ── Periods ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export function periodRange(p: Period): DateRange {
  switch (p.kind) {
    case 'daily':
      return { from: p.date, to: p.date }
    case 'weekly':
      return weekRange(p.date)
    case 'monthly':
      return ethiopianMonthRange(p.year, p.month)
    case 'custom':
      return { from: p.from, to: p.to }
  }
}

/** The default period of each kind around "today" (the tenant-local date). */
export function defaultPeriod(kind: PeriodKind, today: string): Period {
  switch (kind) {
    case 'daily':
    case 'weekly':
      return { kind, date: today }
    case 'monthly': {
      const e = isoToEthiopian(today)
      return { kind, year: e.year, month: e.month }
    }
    case 'custom':
      return { kind, from: weekRange(today).from, to: today }
  }
}

/** The previous (-1) or next (+1) period of the same kind; a custom range moves by its own length. */
export function shiftPeriod(p: Period, delta: -1 | 1): Period {
  switch (p.kind) {
    case 'daily':
      return { ...p, date: addDays(p.date, delta) }
    case 'weekly':
      return { ...p, date: addDays(p.date, 7 * delta) }
    case 'monthly':
      return { kind: 'monthly', ...shiftEthiopianMonth(p.year, p.month, delta) }
    case 'custom': {
      const n = spanDays(p.from, p.to) * delta
      return { kind: 'custom', from: addDays(p.from, n), to: addDays(p.to, n) }
    }
  }
}

/** "13 መስከረም 2019" for a Gregorian date. */
export function ethiopianDateLabel(iso: string): string {
  const e = isoToEthiopian(iso)
  return `${e.day} ${ETHIOPIAN_MONTHS[e.month - 1] ?? ''} ${e.year}`
}

export interface PeriodLabel {
  /** Ethiopian calendar, Arabic numerals. */
  ethiopian: string
  /** Gregorian ISO dates (secondary). */
  gregorian: string
}

export function periodLabel(p: Period): PeriodLabel {
  const r = periodRange(p)
  const gregorian = r.from === r.to ? r.from : `${r.from} – ${r.to}`
  if (p.kind === 'monthly')
    return { ethiopian: `${ETHIOPIAN_MONTHS[p.month - 1] ?? ''} ${p.year}`, gregorian }
  const ethiopian =
    r.from === r.to
      ? ethiopianDateLabel(r.from)
      : `${ethiopianDateLabel(r.from)} – ${ethiopianDateLabel(r.to)}`
  return { ethiopian, gregorian }
}

/** The custom-range form (Zod): two real dates, in order, at most MAX_PERIOD_DAYS days (the server re-validates). */
export const customRangeSchema = z
  .object({ from: z.string().trim(), to: z.string().trim() })
  .superRefine((v, ctx) => {
    if (!isIsoDate(v.from) || !isIsoDate(v.to)) {
      ctx.addIssue({ code: 'custom', message: 'Choose both dates.' })
      return
    }
    const n = spanDays(v.from, v.to)
    if (n < 1) ctx.addIssue({ code: 'custom', message: 'The end date must not be before the start date.' })
    else if (n > MAX_PERIOD_DAYS)
      ctx.addIssue({ code: 'custom', message: `A report covers at most ${MAX_PERIOD_DAYS} days.` })
  })

export function parseCustomRange(
  from: string,
  to: string,
): { ok: true; range: DateRange } | { ok: false; error: string } {
  const r = customRangeSchema.safeParse({ from, to })
  if (r.success) return { ok: true, range: { from: r.data.from, to: r.data.to } }
  return { ok: false, error: r.error.issues[0]?.message ?? 'Invalid range.' }
}

/** Today's calendar date "YYYY-MM-DD" in a time zone (falls back to Addis Ababa for an unknown zone). */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  try {
    return fmt(timeZone)
  } catch {
    return fmt('Africa/Addis_Ababa')
  }
}
