// Ethiopian calendar and clock for user-facing dates (receipts, reports). Arabic numerals only (never Ge'ez numerals).
//  * Calendar: 13 months (12 x 30 days + Pagume 5/6), year starts on Meskerem 1 (11 or 12 September). Converted via the Julian
//    day number; the Amete Mihret epoch is JDN 1724221.
//  * Clock: the day starts at sunrise, so local hours are the international ones shifted by 6 (7:00 AM = 1:00 ጠዋት,
//    12:00 PM = 6:00 ቀትር, 7:00 PM = 1:00 ማታ, 12:00 AM = 6:00 ለሊት).

export const ETHIOPIAN_MONTHS = [
  'መስከረም',
  'ጥቅምት',
  'ኅዳር',
  'ታኅሣሥ',
  'ጥር',
  'የካቲት',
  'መጋቢት',
  'ሚያዝያ',
  'ግንቦት',
  'ሰኔ',
  'ሐምሌ',
  'ነሐሴ',
  'ጳጉሜ',
] as const

export interface EthiopianDate {
  year: number
  month: number // 1..13
  day: number // 1..30
}

const ETHIOPIAN_EPOCH_OFFSET = 1723856 // JDN of the epoch minus 365 (the algorithm's cycle origin)

/** Julian day number of a proleptic Gregorian date (year, month 1..12, day). Integer arithmetic: no Date, no DST. */
export function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12)
  const yy = y + 4800 - a
  const mm = m + 12 * a - 3
  return (
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045
  )
}

/** Inverse of gregorianToJdn: the proleptic Gregorian date (year, month 1..12, day) of a Julian day number. */
export function jdnToGregorian(jdn: number): { year: number; month: number; day: number } {
  const a = jdn + 32044
  const b = Math.floor((4 * a + 3) / 146097)
  const c = a - Math.floor((146097 * b) / 4)
  const d = Math.floor((4 * c + 3) / 1461)
  const e = c - Math.floor((1461 * d) / 4)
  const m = Math.floor((5 * e + 2) / 153)
  return {
    year: 100 * b + d - 4800 + Math.floor(m / 10),
    month: m + 3 - 12 * Math.floor(m / 10),
    day: e - Math.floor((153 * m + 2) / 5) + 1,
  }
}

/** Gregorian calendar date (year, month 1..12, day) to the Ethiopian date. */
export function toEthiopianDate(y: number, m: number, d: number): EthiopianDate {
  const jdn = gregorianToJdn(y, m, d)
  const r = (jdn - ETHIOPIAN_EPOCH_OFFSET) % 1461
  const n = (r % 365) + 365 * Math.floor(r / 1460)
  return {
    year: 4 * Math.floor((jdn - ETHIOPIAN_EPOCH_OFFSET) / 1461) + Math.floor(r / 365) - Math.floor(r / 1460),
    month: Math.floor(n / 30) + 1,
    day: (n % 30) + 1,
  }
}

/** The Ethiopian period of an international hour (0..23). */
export function ethiopianPeriod(hour24: number): string {
  if (hour24 < 6) return 'ለሊት'
  if (hour24 < 12) return 'ጠዋት'
  if (hour24 < 13) return 'ቀትር'
  if (hour24 < 18) return 'ከሰዓት'
  return 'ማታ'
}

/** International hour (0..23) and minute to the Ethiopian clock, e.g. 19:05 -> "1:05 ማታ". */
export function ethiopianClock(hour24: number, minute: number): string {
  const h = (hour24 + 18) % 12 || 12
  return `${h}:${String(minute).padStart(2, '0')} ${ethiopianPeriod(hour24)}`
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function localParts(at: Date, timeZone: string): LocalParts {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(at)
  } catch {
    return localParts(at, 'Africa/Addis_Ababa') // an unknown zone falls back to Ethiopia
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  }
}

/** "13 መስከረም 2019, 1:05 ማታ" (Ethiopian date and clock) for an instant in the restaurant's time zone. */
export function formatEthiopianDateTime(iso: string, timeZone = 'Africa/Addis_Ababa'): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const p = localParts(at, timeZone)
  const e = toEthiopianDate(p.year, p.month, p.day)
  return `${e.day} ${ETHIOPIAN_MONTHS[e.month - 1] ?? ''} ${e.year}, ${ethiopianClock(p.hour, p.minute)}`
}

/** "2026-09-23 19:05" (international date and 24-hour time) in the restaurant's time zone. */
export function formatInternationalDateTime(iso: string, timeZone = 'Africa/Addis_Ababa'): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const p = localParts(at, timeZone)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`
}

/** "1:05 ማታ" (Ethiopian clock only) for an instant in the restaurant's time zone. */
export function formatEthiopianTime(iso: string, timeZone = 'Africa/Addis_Ababa'): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const p = localParts(at, timeZone)
  return ethiopianClock(p.hour, p.minute)
}

/** "13 መስከረም 2019" for a calendar date "YYYY-MM-DD" (a due date: no time zone shift). */
export function formatEthiopianDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!m) return ''
  const e = toEthiopianDate(Number(m[1]), Number(m[2]), Number(m[3]))
  return `${e.day} ${ETHIOPIAN_MONTHS[e.month - 1] ?? ''} ${e.year}`
}
