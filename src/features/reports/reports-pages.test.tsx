import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { DashboardPage } from './DashboardPage'
import { ReportsPage } from './ReportsPage'
import type * as ReportsApi from '@/lib/supabase/reports'
import { RpcError } from '@/lib/supabase/rpc'
import { todayIn } from '@/lib/domain/reports-period'

const h = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  fetchReportPeriod: vi.fn(),
  logReportExport: vi.fn(),
  renderReportPdf: vi.fn(),
  subscribeToActivity: vi.fn(),
  unsubscribe: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/reports', async (importOriginal) => {
  const orig = await importOriginal<typeof ReportsApi>()
  return {
    ...orig,
    fetchDashboard: h.fetchDashboard,
    fetchReportPeriod: h.fetchReportPeriod,
    logReportExport: h.logReportExport,
    subscribeToActivity: h.subscribeToActivity,
  }
})
vi.mock('@/lib/supabase/tenant-logo', () => ({ fetchTenantLogoUrl: vi.fn().mockResolvedValue(null) }))
// the lazily imported PDF module (jsPDF) is replaced: only the export flow is under test here
vi.mock('./report-pdf', () => ({ renderReportPdf: h.renderReportPdf, FALLBACK_NOTE: 'Helvetica fallback note' }))

beforeAll(() => {
  // recharts' ResponsiveContainer needs a ResizeObserver (jsdom has none)
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const RID = '99999999-9999-4999-8999-999999999999'
const PM_A = '11111111-1111-4111-8111-111111111111'
const PM_B = '22222222-2222-4222-8222-222222222222'
const CAT = '33333333-3333-4333-8333-333333333333'
const USER = '44444444-4444-4444-8444-444444444444'
const EXP = '55555555-5555-4555-8555-555555555555'
const ORDER = '66666666-6666-4666-8666-666666666666'

const hours = (at: number, orders: number, sales: number) =>
  Array.from({ length: 24 }, (_, hour) => (hour === at ? { hour, orders, sales } : { hour, orders: 0, sales: 0 }))

const KPIS = {
  order_count: 2,
  cancelled_count: 1,
  items_sold: 3,
  sales_total: 414,
  avg_order_value: 207,
  gross_collected: 414,
  cash_collected: 161,
  expenses_total: 50,
  net_position: 364,
  unpaid_total: 0,
  vouchers_outstanding: 0,
  vouchers_overdue: 0,
}

const floorOnly = {
  timezone: 'Africa/Addis_Ababa',
  open_day: { id: RID, day_no: 99, opened_at: '2026-09-23T06:00:00Z' },
  orders_by_status: { submitted: 2, served: 1, cancelled: 1 },
  recent: [
    { id: ORDER, order_no: 'A-0001', status: 'submitted', payment_status: 'unpaid', table_label: 'T4', created_at: '2026-09-23T16:05:00Z', total: null },
  ],
  low_stock_count: null,
}

function renderWith(ui: React.ReactNode, perms: string[]) {
  const value: AuthValue = {
    status: 'authenticated',
    session: null,
    context: {
      user: { id: USER, first_name: 'Test', username: 'test' },
      restaurant: { id: RID, name: 'Demo', slug: 'demo-cafe', status: 'active' },
      permissions: perms,
      station_ids: [],
    },
    contextStatus: 'ready',
    can: (p) => perms.includes(p),
    signOut: vi.fn(),
    refreshContext: vi.fn(),
  }
  return render(
    <AuthContext.Provider value={value}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  h.fetchDashboard.mockReset()
  h.fetchReportPeriod.mockReset()
  h.logReportExport.mockReset()
  h.renderReportPdf.mockReset()
  h.unsubscribe.mockReset()
  h.subscribeToActivity.mockReset().mockReturnValue(h.unsubscribe)
})

describe('DashboardPage', () => {
  it('a floor-only payload (no reports.view) shows counts but no money, and no low-stock tile when withheld', async () => {
    h.fetchDashboard.mockResolvedValue(floorOnly)
    renderWith(<DashboardPage />, ['dashboard.view'])
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument()
    expect(screen.getByText('Live orders').nextSibling).toHaveTextContent('2')
    expect(screen.queryByTestId('money-kpis')).toBeNull()
    expect(screen.queryByText('Low stock')).toBeNull()
    expect(screen.queryByText(/ETB/)).toBeNull()
    // Ethiopian clock for the order time (16:05 UTC = 19:05 Addis = 1:05 ማታ), Arabic numerals
    const recent = within(screen.getByRole('list', { name: 'Recent orders' }))
    expect(recent.getByText('1:05 ማታ')).toBeInTheDocument()
    expect(screen.getByText(/13 መስከረም 2019/)).toBeInTheDocument()
  })

  it('with money from the server: ETB KPIs, the hourly chart table and the payment-method table', async () => {
    h.fetchDashboard.mockResolvedValue({
      ...floorOnly,
      low_stock_count: 2,
      recent: [{ ...floorOnly.recent[0], total: 161 }],
      money: KPIS,
      by_hour: hours(19, 2, 414),
      by_payment_method: [
        { payment_method_id: PM_B, name: 'Amole', amount: 253, count: 1 },
        { payment_method_id: PM_A, name: 'Cash', amount: 161, count: 1 },
      ],
    })
    renderWith(<DashboardPage />, ['dashboard.view', 'reports.view'])
    const money = await screen.findByTestId('money-kpis')
    expect(within(money).getByText('Collected').nextSibling).toHaveTextContent('ETB 414.00')
    expect(within(money).getByText('cash ETB 161.00')).toBeInTheDocument()
    expect(screen.getByText('Low stock').nextSibling).toHaveTextContent('2')
    const hourTable = screen.getByRole('table', { name: 'Orders by hour' })
    expect(within(hourTable).getByRole('rowheader', { name: '19:00' })).toBeInTheDocument()
    expect(within(hourTable).getByText('1:00 ማታ')).toBeInTheDocument()
    const pm = screen.getByRole('table', { name: 'Collected by payment method' })
    expect(within(pm).getByRole('rowheader', { name: 'Amole' })).toBeInTheDocument()
    expect(within(pm).getByText('ETB 253.00')).toBeInTheDocument()
  })

  it('subscribes to Realtime for its tenant and unsubscribes on unmount; a change event refetches', async () => {
    h.fetchDashboard.mockResolvedValue(floorOnly)
    const view = renderWith(<DashboardPage />, ['dashboard.view'])
    await screen.findByRole('heading', { name: 'Dashboard' })
    expect(h.subscribeToActivity).toHaveBeenCalledWith(RID, expect.any(Function))
    const onChange = h.subscribeToActivity.mock.calls[0]?.[1] as () => void
    onChange()
    await waitFor(() => expect(h.fetchDashboard).toHaveBeenCalledTimes(2))
    view.unmount()
    expect(h.unsubscribe).toHaveBeenCalled()
  })

  it('a failed load shows the error state', async () => {
    h.fetchDashboard.mockRejectedValue(new Error('permission_denied'))
    renderWith(<DashboardPage />, ['dashboard.view'])
    expect(await screen.findByText('The dashboard could not be loaded')).toBeInTheDocument()
  })
})

const ITEM = '77777777-7777-4777-8777-777777777777'

const PERIOD_REPORT = {
  timezone: 'Africa/Addis_Ababa',
  period: { from: '2026-09-21', to: '2026-09-27' },
  days: [{ id: RID, day_no: 99, status: 'closed', opened_at: '2026-09-23T06:00:00Z', closed_at: '2026-09-23T18:00:00Z' }],
  kpis: { ...KPIS, subtotal_total: 360, vat_total: 54 },
  by_day: [{ day_session_id: RID, day_no: 99, date: '2026-09-23', orders: 2, sales: 414, collected: 414, expenses: 50 }],
  by_payment_method: [
    { payment_method_id: PM_B, name: 'Telebirr', amount: 253, count: 1 },
    { payment_method_id: PM_A, name: 'Cash', amount: 161, count: 1 },
  ],
  by_category: [{ category_id: CAT, name: 'Desserts', qty: 2, amount: 140 }],
  by_item: [{ menu_item_id: ITEM, name: 'ቡና', qty: 3, amount: 90 }],
  by_waiter: [{ user_id: USER, name: 'Yonas Tesfaye Bekele', orders: 2, sales: 414 }],
  by_expense_category: [{ expense_category_id: EXP, name: 'Purchases', amount: 50, count: 1 }],
  by_hour: hours(9, 2, 414),
  inventory: {
    low_stock: [{ ingredient_id: CAT, name: 'Milk', unit: 'l', stock: 1.5, min_level: 5 }],
    consumption: [{ ingredient_id: EXP, name: 'Coffee beans', unit: 'kg', qty: 0.25 }],
  },
  cancellations: { count: 1, amount: 70, items: [{ order_no: 'A-0007', total: 70, reason: 'Guest left', cancelled_at: '2026-09-23T16:05:00Z', by_name: 'Hana Girma' }] },
  reversals: { count: 0, amount: 0, items: [] },
  installments: { issued_count: 1, issued_total: 500, down_total: 100, collected_total: 150, outstanding_total: 350, overdue_count: 0 },
  restricted: [],
}

const RESTRICTED_REPORT = {
  ...PERIOD_REPORT,
  kpis: { ...PERIOD_REPORT.kpis, expenses_total: null, net_position: null, vouchers_outstanding: null },
  by_payment_method: null,
  by_waiter: null,
  by_expense_category: null,
  inventory: null,
  installments: null,
  reversals: null,
  restricted: ['payments', 'staff', 'expenses', 'inventory', 'installments'],
}

const tab = (name: string) => screen.getByRole('tab', { name })

describe('ReportsPage', () => {
  const created: Blob[] = []
  beforeEach(() => {
    created.length = 0
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b)
      return 'blob:report'
    })
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    window.print = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('loads today\'s daily summary for the tenant from the server (no tenant id sent) and renders its KPIs and table', async () => {
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    const kpis = await screen.findByTestId('report-kpis')
    const today = todayIn('Africa/Addis_Ababa')
    expect(h.fetchReportPeriod).toHaveBeenCalledWith(today, today)
    expect(within(kpis).getByText('Net position').nextSibling).toHaveTextContent('ETB 364.00')
    expect(tab('Summary')).toHaveAttribute('aria-selected', 'true')
    const byDay = screen.getByRole('table', { name: 'By business day' })
    expect(within(byDay).getByRole('rowheader', { name: '13 መስከረም 2019' })).toBeInTheDocument()
  })

  it('switching period kinds sends the matching Gregorian range; monthly is the Ethiopian month (Pagume included)', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    await user.click(screen.getByRole('button', { name: 'Monthly' }))
    fireEvent.change(screen.getByLabelText('Ethiopian year'), { target: { value: '2015' } })
    await user.selectOptions(screen.getByLabelText('Ethiopian month'), '13')
    await waitFor(() => expect(h.fetchReportPeriod).toHaveBeenLastCalledWith('2023-09-06', '2023-09-11'))
    expect(screen.getByTestId('period-label')).toHaveTextContent('ጳጉሜ 2015')
    await user.click(screen.getByRole('button', { name: 'Next period' }))
    await waitFor(() => expect(h.fetchReportPeriod).toHaveBeenLastCalledWith('2023-09-12', '2023-10-11'))
    await user.click(screen.getByRole('button', { name: 'Weekly' }))
    fireEvent.change(screen.getByLabelText('A date in the week'), { target: { value: '2026-10-14' } })
    await waitFor(() => expect(h.fetchReportPeriod).toHaveBeenLastCalledWith('2026-10-12', '2026-10-18'))
    // a weekly summary shows the by-day trend (sr-only table of the chart)
    expect(await screen.findByRole('table', { name: 'Sales trend' })).toBeInTheDocument()
  })

  it('a custom range is validated locally before any call', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    await user.click(screen.getByRole('button', { name: 'Custom' }))
    await screen.findByTestId('report-kpis')
    const calls = h.fetchReportPeriod.mock.calls.length
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } })
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } })
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A report covers at most 366 days.')
    expect(h.fetchReportPeriod).toHaveBeenCalledTimes(calls)
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
    await user.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(h.fetchReportPeriod).toHaveBeenLastCalledWith('2026-09-01', '2026-10-01'))
  })

  it('report tabs render their own tables with names from the data; arrow keys move between tabs', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    await user.click(tab('Payments by method'))
    expect(within(screen.getByRole('table', { name: 'Collected by payment method' })).getByRole('rowheader', { name: 'Telebirr' })).toBeInTheDocument()
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'rep-tab-payments')
    await user.keyboard('{ArrowRight}')
    expect(tab('Waiter performance')).toHaveFocus()
    expect(within(screen.getByRole('table', { name: 'Sales by staff' })).getByRole('rowheader', { name: 'Yonas Tesfaye Bekele' })).toBeInTheDocument()
    await user.click(tab('Item & category sales'))
    expect(within(screen.getByRole('table', { name: 'Sales by item' })).getByRole('rowheader', { name: 'ቡና' })).toBeInTheDocument()
    await user.click(tab('Cancellations & reversals'))
    const cancelled = screen.getByRole('table', { name: 'Cancelled orders' })
    expect(within(cancelled).getByText('Guest left')).toBeInTheDocument()
    expect(within(cancelled).getByText('13 መስከረም 2019, 1:05 ማታ (2026-09-23 19:05)')).toBeInTheDocument()
    await user.click(tab('Hourly traffic'))
    expect(within(screen.getByRole('table', { name: 'Orders by hour' })).getByRole('rowheader', { name: '09:00' })).toBeInTheDocument()
    await user.click(tab('Installments & vouchers'))
    expect(screen.getByText('Outstanding').nextSibling).toHaveTextContent('ETB 350.00')
  })

  it('sections the server withheld show the neutral notice instead of data', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(RESTRICTED_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    const kpis = await screen.findByTestId('report-kpis')
    expect(within(kpis).getByText('Expenses').nextSibling).toHaveTextContent('Not available with your permissions')
    for (const name of ['Payments by method', 'Waiter performance', 'Expenses', 'Inventory']) {
      await user.click(tab(name))
      expect(screen.getAllByTestId('restricted-notice').length).toBeGreaterThan(0)
      expect(screen.queryByText('Telebirr')).toBeNull()
      expect(screen.queryByText('Yonas Tesfaye Bekele')).toBeNull()
      expect(screen.queryByText('Milk')).toBeNull()
    }
    await user.click(tab('Installments & vouchers'))
    expect(screen.getByText('Outstanding').nextSibling).toHaveTextContent('Not available with your permissions')
    await user.click(tab('Cancellations & reversals'))
    expect(screen.getByRole('region', { name: 'Payment reversals' })).toHaveTextContent('Not available with your permissions')
  })

  it('tenant names are rendered as text, never as markup', async () => {
    h.fetchReportPeriod.mockResolvedValue({ ...PERIOD_REPORT, by_category: [{ category_id: CAT, name: '<img src=x onerror=alert(1)>', qty: 1, amount: 1 }] })
    const user = userEvent.setup()
    const { container } = renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    await user.click(tab('Revenue'))
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('rowheader', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
  })

  it('without reports.export there is no Print / CSV / PDF', async () => {
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Export PDF' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Print' })).toBeNull()
  })

  it('CSV: the export is logged first, then a BOM-prefixed file named <slug>-<report>-<from>_<to>.csv is downloaded', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue({ ...PERIOD_REPORT, by_payment_method: [{ payment_method_id: PM_A, name: '=cmd|calc', amount: 161, count: 1 }] })
    h.logReportExport.mockResolvedValue({ exported_at: '2026-09-23T16:05:00Z' })
    const click = vi.mocked(HTMLAnchorElement.prototype.click)
    let filename = ''
    click.mockImplementation(function (this: HTMLAnchorElement) {
      filename = this.download
    })
    renderWith(<ReportsPage />, ['reports.view', 'reports.export'])
    await screen.findByTestId('report-kpis')
    await user.click(tab('Payments by method'))
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(h.logReportExport).toHaveBeenCalledWith('payments', '2026-09-21', '2026-09-27', 'csv')
    expect(h.logReportExport.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(URL.createObjectURL).mock.invocationCallOrder[0] ?? 0)
    expect(filename).toBe('demo-cafe-payments-2026-09-21_2026-09-27.csv')
    const bytes = new Uint8Array(await created[0]!.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes)
    expect(text).toContain('Report,Payments by method')
    expect(text).toContain("Generated,\"13 መስከረም 2019, 1:05 ማታ\",2026-09-23 19:05")
    expect(text).toContain("'=cmd|calc,1,161")
  })

  it('a refused export log (permission_denied) shows the error and produces nothing', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    h.logReportExport.mockRejectedValue(new RpcError('permission_denied'))
    renderWith(<ReportsPage />, ['reports.view', 'reports.export'])
    await screen.findByTestId('report-kpis')
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to export reports. Nothing was exported.')
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    await user.click(screen.getByRole('button', { name: 'Print' }))
    await waitFor(() => expect(h.logReportExport).toHaveBeenCalledTimes(3))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(h.renderReportPdf).not.toHaveBeenCalled()
    expect(window.print).not.toHaveBeenCalled()
  })

  it('PDF: logged first, then the lazily loaded module renders it; the Helvetica fallback is announced', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    h.logReportExport.mockResolvedValue({ exported_at: '2026-09-23T16:05:00Z' })
    h.renderReportPdf.mockResolvedValue({ blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }), amharicFont: false })
    renderWith(<ReportsPage />, ['reports.view', 'reports.export'])
    await screen.findByTestId('report-kpis')
    await user.click(screen.getByRole('button', { name: 'Export PDF' }))
    await waitFor(() => expect(created).toHaveLength(1))
    expect(h.logReportExport).toHaveBeenCalledWith('summary', '2026-09-21', '2026-09-27', 'pdf')
    expect(h.logReportExport.mock.invocationCallOrder[0]).toBeLessThan(h.renderReportPdf.mock.invocationCallOrder[0] ?? 0)
    const [view, meta, generated] = h.renderReportPdf.mock.calls[0] as [{ title: string }, { restaurantName: string }, { international: string }]
    expect(view.title).toBe('Summary')
    expect(meta.restaurantName).toBe('Demo')
    expect(generated.international).toBe('2026-09-23 19:05')
    expect(await screen.findByText('Helvetica fallback note')).toHaveAttribute('role', 'status')
  })

  it('Print: logged first, then the print-only layout is mounted and printed', async () => {
    const user = userEvent.setup()
    h.fetchReportPeriod.mockResolvedValue(PERIOD_REPORT)
    h.logReportExport.mockResolvedValue({ exported_at: '2026-09-23T16:05:00Z' })
    let printed = ''
    vi.mocked(window.print).mockImplementation(() => {
      printed = document.querySelector('.report-print')?.textContent ?? ''
    })
    renderWith(<ReportsPage />, ['reports.view', 'reports.export'])
    await screen.findByTestId('report-kpis')
    await user.click(screen.getByRole('button', { name: 'Print' }))
    await waitFor(() => expect(window.print).toHaveBeenCalledTimes(1))
    expect(h.logReportExport).toHaveBeenCalledWith('summary', '2026-09-21', '2026-09-27', 'print')
    expect(printed).toContain('Demo')
    expect(printed).toContain('Summary')
    expect(printed).toContain('13 መስከረም 2019, 1:05 ማታ (2026-09-23 19:05)')
    expect(printed).toContain('ETB 364.00')
    await waitFor(() => expect(document.querySelector('.report-print')).toBeNull())
  })
})
