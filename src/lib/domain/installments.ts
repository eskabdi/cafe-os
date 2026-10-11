// Installment schedule PREVIEW (Phase 7). The server (fn_generate_voucher) computes the real schedule from the order total; this
// mirrors its rule so the cashier sees the same figures before confirming. Money is handled in integer cents (no float drift).
//  * balance = total - down
//  * per installment = ceil(balance / n) whole birr, the remainder in the last one
//  * if that leaves the last installment at zero or below: an even split to the cent, the remainder in the last one

export const FREQUENCIES = [
  { days: 7, label: 'Weekly' },
  { days: 14, label: 'Every 2 weeks' },
  { days: 30, label: 'Monthly' },
] as const

export interface ScheduleLine {
  no: number
  dueInDays: number
  amount: number
}

const toCents = (v: number) => Math.round(v * 100)

/** null when the input cannot make a valid schedule (down outside 0 <= down < total, n outside 1..60). */
export function buildSchedule(
  total: number,
  down: number,
  count: number,
  intervalDays: number,
): ScheduleLine[] | null {
  if (
    !Number.isFinite(total) ||
    !Number.isFinite(down) ||
    !Number.isInteger(count) ||
    !Number.isInteger(intervalDays)
  )
    return null
  const t = toCents(total)
  const d = toCents(down)
  if (t <= 0 || d < 0 || d >= t || count < 1 || count > 60 || intervalDays < 1 || intervalDays > 365)
    return null
  const balance = t - d
  let per = Math.ceil(balance / count / 100) * 100
  let last = balance - per * (count - 1)
  if (last <= 0) {
    per = Math.floor(balance / count)
    last = balance - per * (count - 1)
  }
  if (per <= 0) return null
  return Array.from({ length: count }, (_, i) => ({
    no: i + 1,
    dueInDays: intervalDays * (i + 1),
    amount: (i === count - 1 ? last : per) / 100,
  }))
}

export type VoucherStatus = 'active' | 'overdue' | 'settled'
