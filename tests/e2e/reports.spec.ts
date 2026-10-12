import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'
import { expectNoSeriousA11yViolations } from './a11y'

// Dashboard and Reports (Phase 8) against mocked Supabase. Every figure comes from fn_dashboard / fn_report; the client sends only a
// day range (never a tenant id). Payment-method, category, staff and expense-category names are runtime data only.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const DAY = '77777777-7777-4777-8777-777777777777'
const ORDER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const M_AMOLE = '11111111-1111-4111-8111-111111111111'
const M_CASH = '22222222-2222-4222-8222-222222222222'
const CAT = '33333333-3333-4333-8333-333333333333'
const STAFF = '44444444-4444-4444-8444-444444444444'
const EXP = '55555555-5555-4555-8555-555555555555'

const WAITER = ['dashboard.view', 'orders.view', 'orders.create', 'menu.view', 'tables.view']
const MANAGER = ['dashboard.view', 'reports.view', 'orders.view', 'orders.view_all', 'payments.view']

const hours = (at: number, orders: number, sales: number) =>
  Array.from({ length: 24 }, (_, hour) =>
    hour === at ? { hour, orders, sales } : { hour, orders: 0, sales: 0 },
  )

const KPIS = {
  order_count: 2,
  cancelled_count: 1,
  items_sold: 3,
  sales_total: '414.00',
  avg_order_value: '207.00',
  gross_collected: '414.00',
  cash_collected: '161.00',
  expenses_total: '50.00',
  net_position: '364.00',
  unpaid_total: '0.00',
  vouchers_outstanding: '0.00',
  vouchers_overdue: 0,
}

const report = (from: number | null, to: number | null) => ({
  timezone: 'Africa/Addis_Ababa',
  days:
    from === null
      ? [{ id: DAY, day_no: 12, status: 'open', opened_at: '2026-10-10T05:00:00Z', closed_at: null }]
      : Array.from({ length: (to ?? from) - from + 1 }, (_, i) => ({
          id: `77777777-7777-4777-8777-${String(i).padStart(12, '0')}`,
          day_no: from + i,
          status: 'closed',
          opened_at: '2026-10-01T05:00:00Z',
          closed_at: '2026-10-01T20:00:00Z',
        })),
  kpis: KPIS,
  by_payment_method: [
    { payment_method_id: M_AMOLE, name: 'Amole', amount: '253.00', count: 1 },
    { payment_method_id: M_CASH, name: 'Cash Drawer', amount: '161.00', count: 1 },
  ],
  by_category: [{ category_id: CAT, name: 'Desserts', qty: 3, amount: '360.00' }],
  by_waiter: [{ user_id: STAFF, name: 'Yonas Tesfaye', orders: 2, sales: '414.00' }],
  by_expense_category: [{ expense_category_id: EXP, name: 'Purchases', amount: '50.00', count: 1 }],
  by_hour: hours(9, 2, 414),
  inventory: {
    low_stock: [{ ingredient_id: CAT, name: 'Milk', unit: 'l', stock: '1.500', min_level: '5.000' }],
    consumption: [{ ingredient_id: EXP, name: 'Coffee beans', unit: 'kg', qty: '0.250' }],
  },
})

/** fn_report_period: staff figures are withheld without reports.staff (restricted + null section), like the server. */
const periodReport = (from: string, to: string, permissions: string[]) => {
  const base = report(9, 11)
  const staff = permissions.includes('reports.staff')
  if (permissions.includes('cashier-like')) {
    // a cashier-like role: payments yes; expenses, inventory and staff withheld (null + restricted), like the server
    return {
      ...base,
      period: { from, to },
      kpis: {
        ...KPIS,
        subtotal_total: '360.00',
        vat_total: '54.00',
        expenses_total: null,
        net_position: null,
      },
      by_day: [
        {
          day_session_id: DAY,
          day_no: 11,
          date: from,
          orders: 2,
          sales: '414.00',
          collected: '414.00',
          expenses: null,
        },
      ],
      by_item: [],
      by_waiter: null,
      by_expense_category: null,
      inventory: null,
      cancellations: { count: 0, amount: '0.00', items: [] },
      reversals: { count: 0, amount: '0.00', items: [] },
      installments: {
        issued_count: 0,
        issued_total: 0,
        down_total: 0,
        collected_total: 0,
        outstanding_total: 0,
        overdue_count: 0,
      },
      restricted: ['expenses', 'inventory', 'staff'],
    }
  }
  return {
    ...base,
    period: { from, to },
    kpis: { ...KPIS, subtotal_total: '360.00', vat_total: '54.00' },
    by_day: [
      {
        day_session_id: DAY,
        day_no: 11,
        date: from,
        orders: 2,
        sales: '414.00',
        collected: '414.00',
        expenses: '50.00',
      },
    ],
    by_item: [{ menu_item_id: CAT, name: '=1+1 Tiramisu', qty: 3, amount: '360.00' }],
    by_waiter: staff ? base.by_waiter : null,
    cancellations: { count: 0, amount: '0.00', items: [] },
    reversals: { count: 0, amount: '0.00', items: [] },
    installments: {
      issued_count: 0,
      issued_total: 0,
      down_total: 0,
      collected_total: 0,
      outstanding_total: 0,
      overdue_count: 0,
    },
    restricted: staff ? [] : ['staff'],
  }
}

const GRILL = '66666666-6666-4666-8666-666666666666'

/** fn_my_dashboard: the caller's own figures; sections are null without the permission / station access, like the server. */
const myDashboard = (from: string, to: string, permissions: string[], stationIds: string[]) => ({
  timezone: 'Africa/Addis_Ababa',
  period: { from, to },
  day_count: 1,
  own_orders: permissions.includes('orders.create')
    ? {
        order_count: 3,
        sales_total: '724.50',
        avg_order_value: '241.50',
        unpaid_total: '161.00',
        open_count: 1,
        served_count: 2,
        cancelled_count: 1,
        served_rate: 50,
        avg_serve_minutes: 12.5,
        by_hour: hours(9, 3, 724.5),
      }
    : null,
  stations: stationIds.length
    ? [
        {
          station_id: GRILL,
          name: 'Grill',
          color: '#16a34a',
          queue: 4,
          in_progress: 2,
          ready: 1,
          completed: 9,
          avg_prep_minutes: 7.5,
          avg_wait_minutes: 1.5,
        },
      ]
    : null,
})

interface Mock {
  periodBodies: Array<Record<string, unknown>>
  exportBodies: Array<Record<string, unknown>>
  /** order of the RPCs that matter for the export flow */
  events: string[]
  dashboardCalls: number
  myBodies: Array<Record<string, unknown>>
  socket?: { ws: WebSocketRoute; topic: string; joinRef: string }
}

async function setup(
  page: Page,
  permissions: string[],
  opts: { timezone?: string; stationIds?: string[]; systemKey?: string } = {},
): Promise<Mock> {
  const m: Mock = { periodBodies: [], exportBodies: [], events: [], dashboardCalls: 0, myBodies: [] }
  const money = permissions.includes('reports.view')
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'u.staff.cafeos.invalid',
    app_metadata: { staff: true },
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const session = {
    access_token: jwt,
    refresh_token: 'r',
    expires_at: exp,
    expires_in: 3600,
    token_type: 'bearer',
    user,
  }
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session)],
  )
  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const context = {
    user: { id: 'u-1', first_name: 'Hana', short_name: 'Hana Girma', username: 'hana' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: {
      id: '88888888-8888-4888-8888-888888888888',
      name: 'Runner',
      system_key: opts.systemKey ?? null,
      is_active: true,
    },
    permissions,
    station_ids: opts.stationIds ?? [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: DAY, day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
    plan_features: { installments: true },
  }
  const dashboard = () => ({
    timezone: 'Africa/Addis_Ababa',
    open_day: { id: DAY, day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
    orders_by_status: { submitted: 1 + m.dashboardCalls, served: 1 },
    recent: [
      {
        id: ORDER,
        order_no: 'ORD-0050',
        status: 'submitted',
        payment_status: 'unpaid',
        table_label: 'T2',
        created_at: '2026-10-10T16:05:00Z',
        total: money ? '161.00' : null,
      },
    ],
    low_stock_count: money ? 1 : null,
    ...(money
      ? {
          money: KPIS,
          by_hour: hours(19, 2, 414),
          by_payment_method: report(null, null).by_payment_method,
        }
      : {}),
  })
  await page.route('**/auth/v1/**', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill(json(200, user)),
  )
  await page.route('**/rest/v1/**', (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const url = new URL(req.url())
    const parts = url.pathname.split('/')
    const name = parts.pop() ?? ''
    if (parts.includes('rpc')) {
      if (name === 'fn_get_session_context') return r.fulfill(json(200, context))
      if (name === 'fn_get_open_day') return r.fulfill(json(200, context.open_day))
      if (name === 'fn_dashboard') {
        const body = dashboard()
        m.dashboardCalls += 1
        return r.fulfill(json(200, body))
      }
      if (name === 'fn_my_dashboard') {
        const body = (req.postDataJSON() ?? {}) as { p_from: string; p_to: string }
        m.myBodies.push(body)
        return r.fulfill(json(200, myDashboard(body.p_from, body.p_to, permissions, opts.stationIds ?? [])))
      }
      if (name === 'fn_report_period') {
        if (!money)
          return r.fulfill(
            json(400, { code: 'P0001', message: 'permission_denied', details: null, hint: null }),
          )
        const body = (req.postDataJSON() ?? {}) as { p_from: string; p_to: string }
        m.periodBodies.push(body)
        m.events.push('report')
        return r.fulfill(json(200, periodReport(body.p_from, body.p_to, permissions)))
      }
      if (name === 'fn_log_report_export') {
        const body = (req.postDataJSON() ?? {}) as Record<string, unknown>
        m.exportBodies.push(body)
        m.events.push('log')
        if (!permissions.includes('reports.export')) {
          return r.fulfill(
            json(400, { code: 'P0001', message: 'permission_denied', details: null, hint: null }),
          )
        }
        return r.fulfill(json(200, { ok: true, exported_at: '2026-10-10T16:05:00Z' }))
      }
      return r.fulfill(json(200, null))
    }
    // fetchTenantTimezone: restaurants.timezone of the own restaurant (RLS)
    if (name === 'restaurants' && opts.timezone) return r.fulfill(json(200, [{ timezone: opts.timezone }]))
    return r.fulfill(json(200, []))
  })
  await page.route('**/functions/v1/tenant-logo**', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill(json(200, { url: null })),
  )
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw)) as [
        string | null,
        string | null,
        string,
        string,
        { config?: { postgres_changes?: Array<Record<string, string>> } },
      ]
      if (!ref) return
      let response: Record<string, unknown> = {}
      if (event === 'phx_join') {
        const changes = (payload.config?.postgres_changes ?? []).map((c, i) => ({ ...c, id: 2000 + i }))
        response = { postgres_changes: changes }
        if (topic.startsWith(`realtime:activity-${RID}-`)) m.socket = { ws, topic, joinRef: joinRef ?? ref }
      }
      ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]))
    })
  })
  return m
}

/** A new order arrives over Realtime (binding 2000 = the orders postgres_changes of the activity channel). */
function pushOrderChange(m: Mock) {
  if (!m.socket) throw new Error('activity channel not joined')
  const now = new Date().toISOString()
  m.socket.ws.send(
    JSON.stringify([
      m.socket.joinRef,
      null,
      m.socket.topic,
      'postgres_changes',
      {
        ids: [2000],
        data: {
          type: 'INSERT',
          schema: 'public',
          table: 'orders',
          commit_timestamp: now,
          columns: [
            { name: 'id', type: 'uuid' },
            { name: 'restaurant_id', type: 'uuid' },
          ],
          record: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', restaurant_id: RID },
          errors: null,
        },
      },
    ]),
  )
}

test('a waiter (orders.create, no reports.view / orders.view_all) gets the personal dashboard, and has no Reports', async ({
  page,
}) => {
  const m = await setup(page, WAITER)
  await page.goto('/r/demo-cafe/dashboard')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  const kpis = page.getByTestId('my-waiter-kpis')
  await expect(kpis.getByText('ETB 724.50')).toBeVisible()
  await expect(kpis.getByText('ETB 241.50')).toBeVisible()
  await expect(kpis.getByText('50.0% of orders taken')).toBeVisible()
  await expect(kpis.getByText('12.5 min')).toBeVisible()
  await expect(
    page.getByRole('table', { name: 'My orders by hour' }).getByRole('cell', { name: '3:00 ጠዋት' }),
  ).toBeAttached()
  // no floor-wide figure, no station section; the client sends only a date range (no tenant / user id)
  await expect(page.getByText('Live orders')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'My stations' })).toHaveCount(0)
  expect(m.dashboardCalls).toBe(0)
  expect(Object.keys(m.myBodies[0] ?? {}).sort()).toEqual(['p_from', 'p_to'])
  // the period picker re-queries
  await page.getByRole('button', { name: 'Weekly' }).click()
  await expect.poll(() => m.myBodies.length).toBeGreaterThan(1)
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Reports' })).toHaveCount(0)
  // typing the address does not help: the route guard (UX) refuses, and the server would answer permission_denied
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByText('Not authorised')).toBeVisible()
})

test('station staff (station access, no orders.create) get their station figures, names and colours from the data', async ({
  page,
}) => {
  await setup(page, ['dashboard.view', 'orders.view'], { stationIds: [GRILL] })
  await page.goto('/r/demo-cafe/dashboard')
  const st = page.getByTestId('my-station')
  await expect(st.getByRole('heading', { name: 'Grill' })).toBeVisible()
  await expect(st).toHaveAttribute('data-station-id', GRILL)
  await expect(st.getByText('Queue').locator('xpath=following-sibling::p[1]')).toHaveText('4')
  await expect(st.getByText('7.5 min')).toBeVisible()
  await expect(page.getByTestId('my-waiter-kpis')).toHaveCount(0)
  await expect(page.getByText('Live orders')).toHaveCount(0)
  await expectNoSeriousA11yViolations(page, 'Personal dashboard')
})

test('a tenant admin keeps the main dashboard unchanged (fn_dashboard, never fn_my_dashboard)', async ({
  page,
}) => {
  const m = await setup(page, [...MANAGER, 'orders.create', 'orders.cancel_any'], {
    stationIds: [GRILL],
    systemKey: 'tenant_admin',
  })
  await page.goto('/r/demo-cafe/dashboard')
  await expect(page.getByText('Live orders')).toBeVisible()
  await expect(page.getByTestId('money-kpis').getByText('ETB 414.00').first()).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recent orders' }).getByText('ORD-0050')).toBeVisible()
  await expect(page.getByTestId('my-waiter-kpis')).toHaveCount(0)
  expect(m.myBodies).toHaveLength(0)
})

test('a manager sees money on the dashboard, refreshed live over Realtime', async ({ page }) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/dashboard')
  const money = page.getByTestId('money-kpis')
  await expect(money.getByText('ETB 414.00').first()).toBeVisible()
  await expect(
    page
      .getByRole('table', { name: 'Collected by payment method' })
      .getByRole('rowheader', { name: 'Amole' }),
  ).toBeAttached()
  await expect(
    page.getByRole('table', { name: 'Orders by hour' }).getByRole('cell', { name: '1:00 ማታ' }),
  ).toBeAttached()
  await expect
    .poll(() => m.socket?.topic ?? '')
    .toMatch(new RegExp(`^realtime:activity-${RID}-[0-9a-f-]{36}$`))
  const live = page.getByText('Live orders').locator('xpath=following-sibling::p[1]')
  const before = Number(await live.textContent())
  const calls = m.dashboardCalls
  pushOrderChange(m)
  await expect.poll(() => m.dashboardCalls).toBeGreaterThan(calls)
  await expect(live).not.toHaveText(String(before))
})

const EXPORTER = [...MANAGER, 'reports.export', 'reports.staff']

test('a manager report: period label, report types with their own tables, names from the data, no tenant id sent', async ({
  page,
}) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
  const kpis = page.getByTestId('report-kpis')
  await expect(kpis.getByText('ETB 364.00')).toBeVisible()
  const first = m.periodBodies[0] as { p_from: string; p_to: string }
  expect(first.p_from).toBe(first.p_to) // daily by default
  await expect(page.getByTestId('period-label')).toContainText(first.p_from)

  const tabs = page.getByRole('tablist', { name: 'Report type' })
  await expect(tabs.getByRole('tab')).toHaveCount(10)
  await tabs.getByRole('tab', { name: 'Payments by method' }).click()
  await expect(
    page
      .getByRole('table', { name: 'Collected by payment method' })
      .getByRole('rowheader', { name: 'Amole' }),
  ).toBeVisible()
  await tabs.getByRole('tab', { name: 'Item & category sales' }).click()
  await expect(
    page.getByRole('table', { name: 'Sales by item' }).getByRole('rowheader', { name: '=1+1 Tiramisu' }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('table', { name: 'Sales by category (before VAT)' })
      .getByRole('rowheader', { name: 'Desserts' }),
  ).toBeVisible()
  // keyboard: arrows move between tabs
  await tabs.getByRole('tab', { name: 'Item & category sales' }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(tabs.getByRole('tab', { name: 'Installments & vouchers' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await tabs.getByRole('tab', { name: 'Hourly traffic' }).click()
  await expect(
    page.getByRole('table', { name: 'Orders by hour' }).getByRole('rowheader', { name: '09:00' }),
  ).toBeVisible()

  for (const body of m.periodBodies) expect(Object.keys(body).sort()).toEqual(['p_from', 'p_to'])
})

test("'today' is the tenant-local date (restaurants.timezone), not the browser's or Addis Ababa's", async ({
  page,
}) => {
  // a zone whose calendar date differs from Addis Ababa's right now: UTC+14 is ahead from 13:00 Addis time on, UTC-11 is
  // behind before 14:00, so one of them always differs (the real clock is kept: the mocked session token is time-bound)
  const dateIn = (tz: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  const addis = dateIn('Africa/Addis_Ababa')
  const tz =
    ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].find((z) => dateIn(z) !== addis) ?? 'Pacific/Kiritimati'
  const m = await setup(page, MANAGER, { timezone: tz })
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()
  const expected = dateIn(tz)
  expect(expected).not.toBe(addis)
  expect(m.periodBodies[0]).toEqual({ p_from: expected, p_to: expected })
  await expect(page.getByTestId('period-label')).toContainText(expected)
})

test('periods: weekly Monday–Sunday, Ethiopian months with Pagume, prev / next, and a validated custom range', async ({
  page,
}) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()

  await page.getByRole('button', { name: 'Weekly' }).click()
  await page.getByLabel('A date in the week').fill('2026-10-14')
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-10-12', p_to: '2026-10-18' })
  await expect(page.getByTestId('period-label')).toContainText('2 ጥቅምት 2019 – 8 ጥቅምት 2019')
  await expect(page.getByRole('table', { name: 'Sales trend' })).toBeAttached()

  await page.getByRole('button', { name: 'Monthly' }).click()
  // the year is local text while typing: a partial / out-of-range year is never sent, a valid one commits on Enter / blur
  const year = page.getByLabel('Ethiopian year')
  const beforeYear = m.periodBodies.length
  await year.fill('20')
  await year.press('Enter')
  await expect(page.getByRole('alert')).toHaveText('Enter a year from 1990 to 2100.')
  expect(m.periodBodies.length).toBe(beforeYear)
  await year.fill('2018')
  await year.press('Enter')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('Ethiopian month').selectOption('13')
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-09-06', p_to: '2026-09-10' })
  await expect(page.getByTestId('period-label')).toContainText('ጳጉሜ 2018')
  await page.getByRole('button', { name: 'Next period' }).click()
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-09-11', p_to: '2026-10-10' })
  await page.getByRole('button', { name: 'Previous period' }).click()
  await page.getByRole('button', { name: 'Previous period' }).click()
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-08-07', p_to: '2026-09-05' })

  await page.getByRole('button', { name: 'Custom' }).click()
  const sent = m.periodBodies.length
  await page.getByLabel('From', { exact: true }).fill('2025-01-01')
  await page.getByLabel('To', { exact: true }).fill('2026-10-01')
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByRole('alert')).toHaveText('A report covers at most 366 days.')
  await page.getByLabel('From', { exact: true }).fill('2026-09-01')
  await page.getByRole('button', { name: 'Show' }).click()
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-09-01', p_to: '2026-10-01' })
  expect(m.periodBodies.length).toBe(sent + 1)
})

test('without reports.export there is no Print / CSV / PDF, and withheld sections show the neutral notice', async ({
  page,
}) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Export PDF' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Print' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Waiter performance' }).click()
  await expect(page.getByTestId('restricted-notice')).toHaveText('Not available with your permissions')
  await expect(page.getByText('Yonas Tesfaye')).toHaveCount(0)
  expect(m.exportBodies).toHaveLength(0)
})

test('CSV export: audited first, then a BOM-prefixed, injection-safe file named after the slug, report and period', async ({
  page,
}) => {
  const m = await setup(page, EXPORTER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()
  await page.getByRole('button', { name: 'Weekly' }).click()
  await page.getByLabel('A date in the week').fill('2026-10-14')
  await expect.poll(() => m.periodBodies.at(-1)).toEqual({ p_from: '2026-10-12', p_to: '2026-10-18' })
  await page.getByRole('tab', { name: 'Item & category sales' }).click()
  await expect(page.getByRole('table', { name: 'Sales by item' })).toBeVisible()

  const before = m.events.length
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ])
  expect(m.events.slice(before)).toEqual(['log'])
  expect(m.exportBodies.at(-1)).toEqual({
    p_report: 'items',
    p_from: '2026-10-12',
    p_to: '2026-10-18',
    p_format: 'csv',
  })
  expect(download.suggestedFilename()).toBe('demo-cafe-items-2026-10-12_2026-10-18.csv')
  const path = await download.path()
  const fs = await import('node:fs')
  const bytes = fs.readFileSync(path)
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  const text = bytes.toString('utf8')
  expect(text).toContain('Report,Item & category sales\r\n')
  expect(text).toContain('Period (Gregorian),2026-10-12,2026-10-18')
  expect(text).toContain("'=1+1 Tiramisu,3,360")
  expect(text).toContain('Desserts,3,360')
})

test('Waiter performance with reports.staff shows the names; PDF export is audited before the lazy PDF chunk runs', async ({
  page,
}) => {
  const m = await setup(page, EXPORTER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()
  await page.getByRole('tab', { name: 'Waiter performance' }).click()
  await expect(
    page.getByRole('table', { name: 'Sales by staff' }).getByRole('rowheader', { name: 'Yonas Tesfaye' }),
  ).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export PDF' }).click(),
  ])
  expect(m.exportBodies.at(-1)).toMatchObject({ p_report: 'staff', p_format: 'pdf' })
  expect(download.suggestedFilename()).toMatch(/^demo-cafe-staff-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.pdf$/)
  const fs = await import('node:fs')
  expect(
    fs
      .readFileSync(await download.path())
      .subarray(0, 5)
      .toString('latin1'),
  ).toBe('%PDF-')
})

test('a cashier-like role (expenses, inventory, staff withheld) sees notices, and export only for the types it may see', async ({
  page,
}) => {
  const m = await setup(page, [
    'dashboard.view',
    'reports.view',
    'reports.export',
    'payments.view',
    'cashier-like',
  ])
  await page.goto('/r/demo-cafe/reports')
  const kpis = page.getByTestId('report-kpis')
  await expect(kpis.getByText('Collected', { exact: true })).toBeVisible()
  await expect(kpis.getByText('Not available with your permissions')).toHaveCount(2) // expenses, net position
  for (const name of ['Expenses', 'Inventory', 'Waiter performance']) {
    await page.getByRole('tab', { name, exact: true }).click()
    await expect(page.getByTestId('restricted-notice').first()).toHaveText(
      'Not available with your permissions',
    )
    await expect(page.getByRole('button', { name: 'Export CSV' })).toHaveCount(0)
  }
  await expect(page.getByText('Milk')).toHaveCount(0)
  await expect(page.getByText('Purchases')).toHaveCount(0)
  await page.getByRole('tab', { name: 'Payments by method' }).click()
  await expect(
    page
      .getByRole('table', { name: 'Collected by payment method' })
      .getByRole('rowheader', { name: 'Amole' }),
  ).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV' }).click(),
  ])
  expect(m.exportBodies.at(-1)).toMatchObject({ p_report: 'payments', p_format: 'csv' })
  expect(download.suggestedFilename()).toMatch(/^demo-cafe-payments-/)
})

test('a11y: Reports has no serious or critical axe violations', async ({ page }) => {
  await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis').getByText('ETB 364.00').first()).toBeVisible()
  await expectNoSeriousA11yViolations(page, 'Reports')
})
