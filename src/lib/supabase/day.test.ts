import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ callRpc: vi.fn() }))
vi.mock('./client', () => ({ supabase: {} }))
vi.mock('./rpc', () => ({ callRpc: h.callRpc }))

const { closeDay, openDay, fetchClosePreview } = await import('./day')

const DAY = '11111111-1111-4111-8111-111111111111'
const ING = '22222222-2222-4222-8222-222222222222'
const closed = {
  id: DAY, day_no: 4, status: 'closed', opened_at: '2026-10-12T05:00:00Z', opening_float: '1000.00', opened_by: 'Selam T',
  closed_at: '2026-10-12T18:00:00Z', closed_by: 'Selam T', order_count: 2, gross_collected: '414.00', cash_collected: '161.00',
  cash_expenses: '50.00', expenses_total: '50.00', expected_cash: '1111.00', counted_cash: '1100.00', cash_variance: '-11.00',
  net_profit: '364.00', inventory_variance: '-2.000', station_snapshot: [], expense_snapshot: [], payment_snapshot: [], close_note: null,
  replayed: false,
}

beforeEach(() => h.callRpc.mockReset())

describe('day RPCs', () => {
  it('closeDay sends intents only (counted cash, counts, note, key) and parses numeric strings', async () => {
    h.callRpc.mockResolvedValue(closed)
    const d = await closeDay({ countedCash: 1100, stationCounts: [{ ingredient_id: ING, counted: 3 }], note: null, idempotencyKey: 'k-12345678' })
    expect(h.callRpc).toHaveBeenCalledWith('fn_close_day', {
      p_counted_cash: 1100, p_station_counts: [{ ingredient_id: ING, counted: 3 }], p_note: null, p_idempotency_key: 'k-12345678',
    })
    expect(d.cash_variance).toBe(-11)
    expect(d.expected_cash).toBe(1111)
  })
  it('openDay sends the float and the key', async () => {
    h.callRpc.mockResolvedValue({ ...closed, status: 'open', closed_at: null, closed_by: null })
    await openDay(500, 'k-abcdefgh')
    expect(h.callRpc).toHaveBeenCalledWith('fn_open_day', { p_opening_float: 500, p_idempotency_key: 'k-abcdefgh' })
  })
  it('rejects a malformed preview', async () => {
    h.callRpc.mockResolvedValue({ day_id: 'nope' })
    await expect(fetchClosePreview()).rejects.toThrow()
  })
})
