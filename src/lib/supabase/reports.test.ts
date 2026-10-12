import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ callRpc: vi.fn() }))
vi.mock('./client', () => ({ supabase: {} }))
vi.mock('./rpc', () => ({ callRpc: h.callRpc }))

const { fetchDashboard, fetchReport, fetchReportPeriod, logReportExport } = await import('./reports')

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
    expect(r.by_payment_method?.[0]?.amount).toBe(12.5)
  })

  it('tolerates the sections withheld from a role without expenses / inventory / staff / payments permissions', async () => {
    h.callRpc.mockResolvedValue({
      timezone: 'Africa/Addis_Ababa',
      days: [],
      kpis: { ...kpis, gross_collected: null, cash_collected: null, expenses_total: null, net_position: null, vouchers_outstanding: null, vouchers_overdue: null },
      by_payment_method: null,
      by_category: [],
      by_waiter: null,
      by_expense_category: null,
      by_hour: [],
      inventory: null,
    })
    const r = await fetchReport(null, null)
    expect(r.kpis.expenses_total).toBeNull()
    expect(r.kpis.vouchers_overdue).toBeNull()
    expect(r.by_waiter).toBeNull()
    expect(r.inventory).toBeNull()
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

  it('accepts a money block whose section figures are withheld (null)', async () => {
    h.callRpc.mockResolvedValue({
      timezone: 'Africa/Addis_Ababa',
      open_day: null,
      orders_by_status: {},
      recent: [],
      low_stock_count: null,
      money: { ...kpis, expenses_total: null, net_position: null, vouchers_outstanding: null, vouchers_overdue: null },
    })
    const d = await fetchDashboard()
    expect(d.money?.expenses_total).toBeNull()
    expect(d.money?.gross_collected).toBe(12.5)
  })
})

describe('fetchReportPeriod', () => {
  const base = {
    timezone: 'Africa/Addis_Ababa',
    period: { from: '2026-09-11', to: '2026-10-10' },
    days: [],
    kpis: { ...kpis, subtotal_total: '10.87', vat_total: '1.63' },
    by_day: [],
    by_payment_method: [{ payment_method_id: PM, name: 'Amole', amount: '12.50', count: 1 }],
    by_category: [],
    by_item: [],
    by_waiter: [],
    by_expense_category: [],
    by_hour: [],
    inventory: { low_stock: [], consumption: [] },
    cancellations: { count: 0, amount: 0, items: [] },
    reversals: { count: 0, amount: 0, items: [] },
    installments: { issued_count: 0, issued_total: 0, down_total: 0, collected_total: 0, outstanding_total: 0, overdue_count: 0 },
    restricted: [],
  }

  it('sends only the dates (no tenant id) and parses numeric strings', async () => {
    h.callRpc.mockResolvedValue(base)
    const r = await fetchReportPeriod('2026-09-11', '2026-10-10')
    expect(h.callRpc).toHaveBeenCalledWith('fn_report_period', { p_from: '2026-09-11', p_to: '2026-10-10' })
    expect(r.kpis.vat_total).toBe(1.63)
    expect(r.by_payment_method?.[0]?.amount).toBe(12.5)
  })

  it('tolerates withheld (null or absent) sections and KPIs; unknown restricted names are dropped', async () => {
    h.callRpc.mockResolvedValue({
      ...base,
      kpis: { ...kpis, expenses_total: null, net_position: null, subtotal_total: '10.87' },
      by_expense_category: null,
      by_waiter: null,
      inventory: null,
      installments: null,
      reversals: undefined,
      restricted: ['expenses', 'staff', 'inventory', 'installments', 'something_else'],
    })
    const r = await fetchReportPeriod('2026-09-11', '2026-10-10')
    expect(r.kpis.expenses_total).toBeNull()
    expect(r.kpis.vat_total).toBeNull()
    expect(r.by_waiter).toBeNull()
    expect(r.inventory).toBeNull()
    expect(r.reversals).toBeNull()
    expect(r.restricted).toEqual(['expenses', 'staff', 'inventory', 'installments'])
  })

  it('rejects a malformed period', async () => {
    h.callRpc.mockResolvedValue({ ...base, period: { from: 'yesterday', to: '2026-10-10' } })
    await expect(fetchReportPeriod('2026-09-11', '2026-10-10')).rejects.toThrow()
  })
})

describe('logReportExport', () => {
  it('sends report, dates and format; returns the server time', async () => {
    h.callRpc.mockResolvedValue({ ok: true, exported_at: '2026-10-12T09:00:00Z' })
    await expect(logReportExport('payments', '2026-10-12', '2026-10-18', 'csv')).resolves.toEqual({ exported_at: '2026-10-12T09:00:00Z' })
    expect(h.callRpc).toHaveBeenCalledWith('fn_log_report_export', { p_report: 'payments', p_from: '2026-10-12', p_to: '2026-10-18', p_format: 'csv' })
  })
  it('a response without ok: true fails (nothing may be exported)', async () => {
    h.callRpc.mockResolvedValue({ ok: false })
    await expect(logReportExport('summary', '2026-10-12', '2026-10-12', 'pdf')).rejects.toThrow()
  })
})
