import { describe, expect, it } from 'vitest'
import { ageBand, groupTickets, minutesSince, nextAction, type KdsLine } from './kds'

const line = (o: Partial<KdsLine>): KdsLine => ({
  id: 'l1', orderId: 'o1', orderNo: 'ORD-0001', tableLabel: null, orderType: 'dine-in', orderCreatedAt: '2026-10-10T08:00:00Z',
  lineNo: 1, name: 'Item', qty: 1, note: null, status: 'pending', ...o,
})

describe('KDS tickets', () => {
  it('groups lines per order, oldest first, lines in cart order', () => {
    const t = groupTickets([
      line({ id: 'b2', orderId: 'o2', orderNo: 'ORD-0002', orderCreatedAt: '2026-10-10T08:05:00Z', lineNo: 2 }),
      line({ id: 'a1', orderId: 'o1', lineNo: 1 }),
      line({ id: 'b1', orderId: 'o2', orderNo: 'ORD-0002', orderCreatedAt: '2026-10-10T08:05:00Z', lineNo: 1 }),
    ])
    expect(t.map((x) => x.orderNo)).toEqual(['ORD-0001', 'ORD-0002'])
    expect(t[1]?.lines.map((l) => l.id)).toEqual(['b1', 'b2'])
  })
  it('rolls up the ticket status and the next action', () => {
    const [p] = groupTickets([line({}), line({ id: 'l2' })])
    expect(p?.status).toBe('pending')
    expect(nextAction(p!)).toBe('preparing')
    const [m] = groupTickets([line({ status: 'preparing' }), line({ id: 'l2' })])
    expect(m?.status).toBe('preparing')
    expect(nextAction(m!)).toBe('ready')
    const [r] = groupTickets([line({ status: 'ready' })])
    expect(r?.status).toBe('ready')
    expect(nextAction(r!)).toBeNull()
  })
  it('ages tickets in whole minutes with fixed bands', () => {
    const now = Date.parse('2026-10-10T08:25:30Z')
    expect(minutesSince('2026-10-10T08:00:00Z', now)).toBe(25)
    expect(minutesSince('garbage', now)).toBe(0)
    expect(ageBand(3)).toBe('ok')
    expect(ageBand(12)).toBe('warning')
    expect(ageBand(25)).toBe('late')
  })
})
