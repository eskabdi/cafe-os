// Decimal input parsing and display helpers (PREVIEW / VALIDATION ONLY: the database is the authority for prices, stock and
// totals). Inputs are kept as strings until they are validated; output always uses Arabic numerals (0-9), never locale digits.

/**
 * Parses a user-typed decimal ("12", "12.5", "0.125") with at most `maxDecimals` fraction digits. Returns null for anything
 * else (signs only when `allowNegative`, no exponent, no grouping separators, no locale digits). The returned number is the
 * shortest round-trip representation of the typed decimal, so JSON-serialising it sends exactly the typed value.
 */
export function parseDecimal(input: string, maxDecimals: number, allowNegative = false): number | null {
  const s = input.trim()
  const fraction = maxDecimals > 0 ? `(?:\\.\\d{1,${maxDecimals}})?` : ''
  const re = new RegExp(`^${allowNegative ? '-?' : ''}\\d{1,12}${fraction}$`)
  if (!re.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Groups the integer part with commas: "1234567.50" -> "1,234,567.50". ASCII digits only. */
function group(plain: string): string {
  const [whole = '0', frac] = plain.split('.')
  const neg = whole.startsWith('-')
  const digits = neg ? whole.slice(1) : whole
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${grouped}${frac !== undefined ? `.${frac}` : ''}`
}

/** "ETB 1,250.50". Accepts the JSON number (or numeric string) the server returned. */
export function formatEtb(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (n === null || n === undefined || !Number.isFinite(n)) return 'ETB —'
  const minor = Math.round(Math.abs(n) * 100)
  const plain = `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`
  return `ETB ${n < 0 && minor !== 0 ? '-' : ''}${group(plain)}`
}

/** A stock quantity with up to 3 decimals, trailing zeros trimmed: 2.5 -> "2.5", 1200 -> "1,200", -0.125 -> "-0.125". */
export function formatQty(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? Number(value) : value
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const milli = Math.round(Math.abs(n) * 1000)
  const whole = Math.trunc(milli / 1000)
  const frac = String(milli % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '')
  const plain = frac ? `${whole}.${frac}` : String(whole)
  return `${n < 0 && milli !== 0 ? '-' : ''}${group(plain)}`
}

/** Signed quantity for a ledger row: "+5", "-0.25". */
export function formatSignedQty(value: number): string {
  const s = formatQty(value)
  return value > 0 ? `+${s}` : s
}
