// Pure station-display (KDS) model, Phase 5. Lines of ONE station grouped into tickets per order, oldest first. Nothing here
// knows a station, category or item NAME: tickets are keyed by order id and lines by their own id.

export type LineStatus = 'pending' | 'preparing' | 'ready'

export interface KdsLine {
  id: string
  orderId: string
  orderNo: string
  tableLabel: string | null
  orderType: string
  orderCreatedAt: string
  lineNo: number | null
  name: string
  qty: number
  note: string | null
  status: LineStatus
}

export interface Ticket {
  orderId: string
  orderNo: string
  tableLabel: string | null
  orderType: string
  createdAt: string
  lines: KdsLine[]
  /** The ticket's state at this station: pending until any line starts, ready only when every line is ready. */
  status: LineStatus
}

export function groupTickets(lines: readonly KdsLine[]): Ticket[] {
  const byOrder = new Map<string, Ticket>()
  for (const l of lines) {
    let t = byOrder.get(l.orderId)
    if (!t) {
      t = { orderId: l.orderId, orderNo: l.orderNo, tableLabel: l.tableLabel, orderType: l.orderType, createdAt: l.orderCreatedAt, lines: [], status: 'pending' }
      byOrder.set(l.orderId, t)
    }
    t.lines.push(l)
  }
  const out = [...byOrder.values()]
  for (const t of out) {
    t.lines.sort((a, b) => (a.lineNo ?? 99) - (b.lineNo ?? 99) || a.id.localeCompare(b.id))
    t.status = t.lines.every((l) => l.status === 'ready') ? 'ready' : t.lines.some((l) => l.status !== 'pending') ? 'preparing' : 'pending'
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.orderNo.localeCompare(b.orderNo))
}

/** Whole minutes since `iso` (never negative); for the ticket age badge. */
export function minutesSince(iso: string, now: number = Date.now()): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : Math.max(0, Math.floor((now - t) / 60_000))
}

/** Age bands for the ticket colour: ok (< 10 min), warning (< 20 min), late. Status colours are fixed, never tenant-branded. */
export function ageBand(minutes: number): 'ok' | 'warning' | 'late' {
  return minutes < 10 ? 'ok' : minutes < 20 ? 'warning' : 'late'
}

/** The next action for a ticket at this station. */
export function nextAction(t: Ticket): 'preparing' | 'ready' | null {
  if (t.status === 'pending') return 'preparing'
  if (t.status === 'preparing') return 'ready'
  return null
}
