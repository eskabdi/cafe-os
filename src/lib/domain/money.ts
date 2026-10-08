/**
 * PREVIEW-ONLY money helpers.
 *
 * The database is the authority for prices, VAT and totals (numeric columns,
 * server-side RPCs). These helpers exist so the UI can show an instant,
 * non-binding estimate (cart preview, VAT breakdown) without float drift.
 * Never send their output to the server as a price or total.
 *
 * Amounts are integer minor units (santim for ETB: 1 ETB = 100 santim).
 * Rates are expressed in basis points (15% = 1500 bps).
 */

export const MINOR_PER_MAJOR = 100

/** Parse a decimal string such as "12.5" or "1200" to integer minor units. */
export function toMinorUnits(input: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) throw new RangeError(`Invalid money amount: "${input}"`)
  const [, sign, whole, frac = ''] = match
  const minor = Number(whole) * MINOR_PER_MAJOR + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(minor)) throw new RangeError(`Money amount out of range: "${input}"`)
  return sign === '-' ? -minor : minor
}

/** Format integer minor units as a plain decimal string with Arabic numerals, e.g. 125050 -> "1250.50". */
export function formatMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError('Minor units must be a safe integer')
  const sign = minor < 0 ? '-' : ''
  const abs = Math.abs(minor)
  const whole = Math.trunc(abs / MINOR_PER_MAJOR)
  const frac = String(abs % MINOR_PER_MAJOR).padStart(2, '0')
  return `${sign}${whole}.${frac}`
}

export interface VatPreview {
  /** Amount before VAT, minor units. */
  net: number
  /** VAT amount, minor units. */
  vat: number
  /** Amount including VAT, minor units. */
  gross: number
}

/** Divide rounding half away from zero, integers only. */
function divRound(numerator: number, denominator: number): number {
  const r = Math.floor((2 * Math.abs(numerator) + denominator) / (2 * denominator))
  return numerator < 0 ? -r : r
}

/**
 * Preview VAT for a VAT-exclusive amount (net + VAT = gross).
 * PREVIEW ONLY - the server computes the authoritative figures.
 */
export function previewVatExclusive(netMinor: number, rateBps: number): VatPreview {
  assertInputs(netMinor, rateBps)
  const vat = divRound(netMinor * rateBps, 10_000)
  return { net: netMinor, vat, gross: netMinor + vat }
}

/**
 * Preview VAT contained in a VAT-inclusive amount (gross = net + VAT).
 * PREVIEW ONLY - the server computes the authoritative figures.
 */
export function previewVatInclusive(grossMinor: number, rateBps: number): VatPreview {
  assertInputs(grossMinor, rateBps)
  const net = divRound(grossMinor * 10_000, 10_000 + rateBps)
  return { net, vat: grossMinor - net, gross: grossMinor }
}

function assertInputs(amountMinor: number, rateBps: number): void {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('Amount must be a safe integer of minor units')
  if (!Number.isSafeInteger(rateBps) || rateBps < 0)
    throw new RangeError('Rate must be a non-negative integer (basis points)')
}
