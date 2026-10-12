import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

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
  Array.from({ length: 24 }, (_, hour) => (hour === at ? { hour, orders, sales } : { hour, orders: 0, sales: 0 }))

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

interface Mock {
  reportBodies: Array<Record<string, unknown>>
  dashboardCalls: number
  socket?: { ws: WebSocketRoute; topic: string; joinRef: string }
}

async function setup(page: Page, permissions: string[]): Promise<Mock> {
  const m: Mock = { reportBodies: [], dashboardCalls: 0 }
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
  const session = { access_token: jwt, refresh_token: 'r', expires_at: exp, expires_in: 3600, token_type: 'bearer', user }
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
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions,
    station_ids: [],
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
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, user)),
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
      if (name === 'fn_report') {
        if (!money) return r.fulfill(json(400, { code: 'P0001', message: 'permission_denied', details: null, hint: null }))
        const body = (req.postDataJSON() ?? {}) as { p_from_day_no?: number | null; p_to_day_no?: number | null }
        m.reportBodies.push(body)
        return r.fulfill(json(200, report(body.p_from_day_no ?? null, body.p_to_day_no ?? null)))
      }
      return r.fulfill(json(200, null))
    }
    return r.fulfill(json(200, []))
  })
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

test('a waiter (dashboard.view without reports.view) sees the floor but no money, and has no Reports', async ({ page }) => {
  await setup(page, WAITER)
  await page.goto('/r/demo-cafe/dashboard')
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
  await expect(page.getByText('Live orders')).toBeVisible()
  await expect(page.getByRole('list', { name: 'Recent orders' }).getByText('ORD-0050')).toBeVisible()
  await expect(page.getByTestId('money-kpis')).toHaveCount(0)
  await expect(page.getByText(/ETB/)).toHaveCount(0)
  await expect(page.getByText('Low stock')).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Reports' })).toHaveCount(0)
  // typing the address does not help: the route guard (UX) refuses, and the server would answer permission_denied
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByText('Not authorised')).toBeVisible()
})

test('a manager sees money on the dashboard, refreshed live over Realtime', async ({ page }) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/dashboard')
  const money = page.getByTestId('money-kpis')
  await expect(money.getByText('ETB 414.00').first()).toBeVisible()
  await expect(page.getByRole('table', { name: 'Collected by payment method' }).getByRole('rowheader', { name: 'Amole' })).toBeAttached()
  await expect(page.getByRole('table', { name: 'Orders by hour' }).getByRole('cell', { name: '1:00 ማታ' })).toBeAttached()
  await expect.poll(() => m.socket?.topic ?? '').toMatch(new RegExp(`^realtime:activity-${RID}-[0-9a-f-]{36}$`))
  const live = page.getByText('Live orders').locator('xpath=following-sibling::p[1]')
  const before = Number(await live.textContent())
  const calls = m.dashboardCalls
  pushOrderChange(m)
  await expect.poll(() => m.dashboardCalls).toBeGreaterThan(calls)
  await expect(live).not.toHaveText(String(before))
})

test('a manager report renders the KPIs and a table for every chart, with names from the data', async ({ page }) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByRole('heading', { level: 1, name: 'Reports' })).toBeVisible()
  const kpis = page.getByTestId('report-kpis')
  await expect(kpis.getByText('ETB 364.00')).toBeVisible()
  await expect(kpis.getByText('ETB 50.00')).toBeVisible()
  await expect(page.getByTestId('report-days')).toContainText('Business day 12 (open)')
  expect(m.reportBodies[0]).toEqual({ p_from_day_no: null, p_to_day_no: null })
  for (const [table, row] of [
    ['Orders by hour', '09:00'],
    ['Collected by payment method', 'Amole'],
    ['Sales by category (before VAT)', 'Desserts'],
    ['Sales by staff', 'Yonas Tesfaye'],
    ['Expenses by category', 'Purchases'],
  ] as const) {
    await expect(page.getByRole('table', { name: table }).getByRole('rowheader', { name: row })).toBeAttached()
  }
  await expect(page.getByRole('list', { name: 'Low stock now' }).getByText('Milk')).toBeVisible()
  // the request never carries a tenant id
  for (const body of m.reportBodies) expect(Object.keys(body).sort()).toEqual(['p_from_day_no', 'p_to_day_no'])
})

test('the day-range picker validates locally and sends only the day numbers', async ({ page }) => {
  const m = await setup(page, MANAGER)
  await page.goto('/r/demo-cafe/reports')
  await expect(page.getByTestId('report-kpis')).toBeVisible()
  const sent = m.reportBodies.length

  await page.getByLabel('From day').fill('9')
  await page.getByLabel('To day').fill('3')
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByRole('alert')).toHaveText('The last day must not be before the first day.')
  expect(m.reportBodies.length).toBe(sent)

  await page.getByLabel('To day').fill('11')
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByTestId('report-days')).toContainText('Business days 9–11 (3 days)')
  expect(m.reportBodies.at(-1)).toEqual({ p_from_day_no: 9, p_to_day_no: 11 })

  await page.getByRole('button', { name: 'Current day' }).click()
  await expect(page.getByTestId('report-days')).toContainText('Business day 12 (open)')
  await expect(page.getByLabel('From day')).toHaveValue('')
})
