import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ callRpc: vi.fn() }))
vi.mock('./client', () => ({ supabase: {} }))
vi.mock('./rpc', () => ({ callRpc: h.callRpc }))

const { fetchDashboard, fetchReport } = await import('./reports')

const PM = '11111111-1111-4111-8111-111111111111'
const kpis = {
  order_count: 0,
  cancelled_count: 0,
  items_sold: 0,
  sales_total: '0.00',
  avg_order_value: 0,
  gross_collected: '12.50',
  cash_collected: 0,
  expenses_total: 0,
  net_position: '12.50',
  unpaid_total: 0,
  vouchers_outstanding: 0,
  vouchers_overdue: 0,
}

beforeEach(() => h.callRpc.mockReset())

describe('fetchReport', () => {
  it('sends only the day range (no tenant id) and parses numeric strings', async () => {
    h.callRpc.mockResolvedValue({
      timezone: 'Africa/Addis_Ababa',
      days: [],
      kpis,
      by_payment_method: [{ payment_method_id: PM, name: 'Amole', amount: '12.50', count: 1 }],
      by_category: [],
      by_waiter: [],
      by_expense_category: [],
      by_hour: [],
      inventory: { low_stock: [], consumption: [] },
    })
    const r = await fetchReport(3, 7)
    expect(h.callRpc).toHaveBeenCalledWith('fn_report', { p_from_day_no: 3, p_to_day_no: 7 })
    expect(r.kpis.gross_collected).toBe(12.5)
    expect(r.by_payment_method[0]?.amount).toBe(12.5)
  })

  it('a malformed time zone falls back to Addis Ababa', async () => {
    h.callRpc.mockResolvedValue({
      timezone: 'x; drop',
      days: [],
      kpis,
      by_payment_method: [],
      by_category: [],
      by_waiter: [],
      by_expense_category: [],
      by_hour: [],
      inventory: { low_stock: [], consumption: [] },
    })
    expect((await fetchReport(null, null)).timezone).toBe('Africa/Addis_Ababa')
  })

  it('rejects a payload that does not match the contract', async () => {
    h.callRpc.mockResolvedValue({ kpis: {} })
    await expect(fetchReport(null, null)).rejects.toThrow()
  })
})

describe('fetchDashboard', () => {
  it('accepts the floor-only shape (money absent, low_stock_count withheld)', async () => {
    h.callRpc.mockResolvedValue({ timezone: 'Africa/Addis_Ababa', open_day: null, orders_by_status: {}, recent: [], low_stock_count: null })
    const d = await fetchDashboard()
    expect(h.callRpc).toHaveBeenCalledWith('fn_dashboard')
    expect(d.money).toBeUndefined()
    expect(d.low_stock_count).toBeNull()
  })
})
