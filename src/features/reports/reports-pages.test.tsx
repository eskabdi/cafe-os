import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthValue } from '@/features/auth/useAuth'
import { DashboardPage } from './DashboardPage'
import { ReportsPage } from './ReportsPage'

const h = vi.hoisted(() => ({
  fetchDashboard: vi.fn(),
  fetchReport: vi.fn(),
  subscribeToActivity: vi.fn(),
  unsubscribe: vi.fn(),
}))
vi.mock('@/lib/supabase/client', () => ({ supabase: {} }))
vi.mock('@/lib/supabase/reports', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/supabase/reports')>()
  return { ...orig, fetchDashboard: h.fetchDashboard, fetchReport: h.fetchReport, subscribeToActivity: h.subscribeToActivity }
})

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
  h.fetchReport.mockReset()
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

const REPORT = {
  timezone: 'Africa/Addis_Ababa',
  days: [{ id: RID, day_no: 99, status: 'open', opened_at: '2026-09-23T06:00:00Z', closed_at: null }],
  kpis: KPIS,
  by_payment_method: [
    { payment_method_id: PM_B, name: 'Telebirr', amount: 253, count: 1 },
    { payment_method_id: PM_A, name: 'Cash', amount: 161, count: 1 },
  ],
  by_category: [{ category_id: CAT, name: 'Desserts', qty: 2, amount: 140 }],
  by_waiter: [{ user_id: USER, name: 'Yonas Tesfaye', orders: 2, sales: 414 }],
  by_expense_category: [{ expense_category_id: EXP, name: 'Purchases', amount: 50, count: 1 }],
  by_hour: hours(9, 2, 414),
  inventory: {
    low_stock: [{ ingredient_id: CAT, name: 'Milk', unit: 'l', stock: 1.5, min_level: 5 }],
    consumption: [{ ingredient_id: EXP, name: 'Coffee beans', unit: 'kg', qty: 0.25 }],
  },
}

describe('ReportsPage', () => {
  it('renders the KPIs and one table per chart from the server figures (names from the data)', async () => {
    h.fetchReport.mockResolvedValue(REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    const kpis = await screen.findByTestId('report-kpis')
    expect(h.fetchReport).toHaveBeenCalledWith(null, null)
    expect(within(kpis).getByText('Net position').nextSibling).toHaveTextContent('ETB 364.00')
    expect(within(kpis).getByText('Expenses').nextSibling).toHaveTextContent('ETB 50.00')
    expect(screen.getByTestId('report-days')).toHaveTextContent('Business day 99 (open), opened 13 መስከረም 2019, 3:00 ጠዋት')
    for (const [table, row] of [
      ['Orders by hour', '09:00'],
      ['Collected by payment method', 'Telebirr'],
      ['Sales by category (before VAT)', 'Desserts'],
      ['Sales by staff', 'Yonas Tesfaye'],
      ['Expenses by category', 'Purchases'],
    ] as const) {
      expect(within(screen.getByRole('table', { name: table })).getByRole('rowheader', { name: row })).toBeInTheDocument()
    }
    expect(within(screen.getByRole('list', { name: 'Low stock now' })).getByText('1.5 / 5 l')).toBeInTheDocument()
  })

  it('the day-range picker sends the parsed range; an invalid range is refused before any call', async () => {
    const user = userEvent.setup()
    h.fetchReport.mockResolvedValue(REPORT)
    renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    await user.type(screen.getByLabelText('From day'), '5')
    await user.type(screen.getByLabelText('To day'), '2')
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The last day must not be before the first day.')
    expect(h.fetchReport).toHaveBeenCalledTimes(1)
    await user.clear(screen.getByLabelText('To day'))
    await user.type(screen.getByLabelText('To day'), '12')
    await user.click(screen.getByRole('button', { name: 'Show' }))
    await waitFor(() => expect(h.fetchReport).toHaveBeenLastCalledWith(5, 12))
    expect(screen.queryByRole('alert')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Current day' }))
    await waitFor(() => expect(h.fetchReport).toHaveBeenLastCalledWith(null, null))
  })

  it('tenant names are rendered as text, never as markup', async () => {
    h.fetchReport.mockResolvedValue({ ...REPORT, by_category: [{ category_id: CAT, name: '<img src=x onerror=alert(1)>', qty: 1, amount: 1 }] })
    const { container } = renderWith(<ReportsPage />, ['reports.view'])
    await screen.findByTestId('report-kpis')
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByRole('rowheader', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument()
  })
})
