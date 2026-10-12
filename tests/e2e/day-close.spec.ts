import { expect, test, type Page } from '@playwright/test'

// Day close (Phase 9) against mocked Supabase. GATE (execution prompt E2E FLOW 3): open day -> expense -> count cash -> count station
// stock -> close -> verify variance -> open a NEW day (a closed day never reopens) -> the closed day stays readable in the history.
// The client sends only intents (counted cash, per-ingredient counts, note, opening float, idempotency keys); every figure is the
// server's. Station, payment-method and expense-category names are runtime data only (Grill, Amole, Purchases).
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
const DAY2 = '77777777-7777-4777-8777-000000000013'
const OLD = '77777777-7777-4777-8777-000000000011'
const M_CASH = '22222222-2222-4222-8222-222222222222'
const M_AMOLE = '11111111-1111-4111-8111-111111111111'
const ST_GRILL = '33333333-3333-4333-8333-333333333333'
const ING = '44444444-4444-4444-8444-444444444444'
const EXP_CAT = '55555555-5555-4555-8555-555555555555'

const MANAGER = ['day_close.execute', 'day.open', 'reports.view', 'expenses.view', 'expenses.manage']

const stationSnapshot = (counted: number) => [
  {
    station_id: ST_GRILL,
    name: 'Grill',
    expected: '12.000',
    counted: counted.toFixed(3),
    variance: (counted - 12).toFixed(3),
    items: [
      {
        ingredient_id: ING,
        name: 'Beef',
        unit: 'kg',
        expected: '12.000',
        counted: counted.toFixed(3),
        variance: (counted - 12).toFixed(3),
      },
    ],
  },
]

const closedOld = {
  id: OLD,
  day_no: 11,
  status: 'closed',
  opened_at: '2026-10-09T05:00:00Z',
  opening_float: '500.00',
  opened_by: 'Selam Tadesse',
  closed_at: '2026-10-09T18:00:00Z',
  closed_by: 'Selam Tadesse',
  order_count: 5,
  gross_collected: '900.00',
  cash_collected: '400.00',
  cash_expenses: '0.00',
  expenses_total: '0.00',
  expected_cash: '900.00',
  counted_cash: '900.00',
  cash_variance: '0.00',
  net_profit: '900.00',
  inventory_variance: '0.000',
  station_snapshot: [],
  expense_snapshot: [],
  payment_snapshot: [],
  close_note: null,
}

async function setup(page: Page, opts: { permissions?: string[]; unpaid?: number } = {}) {
  const calls: Record<string, Array<Record<string, unknown>>> = { close: [], open: [], expense: [] }
  const state: {
    open: { id: string; day_no: number; opened_at: string } | null
    days: Array<Record<string, unknown>>
  } = {
    open: { id: DAY, day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
    days: [{ ...closedOld }],
  }
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'owner@example.com',
    app_metadata: {},
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
  const context = () => ({
    user: { id: 'u-1', first_name: 'Selam', short_name: 'Selam Tadesse', username: 'selam' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: opts.permissions ?? MANAGER,
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: state.open,
    plan_features: {},
  })
  const expenses: Array<Record<string, unknown>> = []
  const preview = () => ({
    day_id: state.open?.id ?? DAY,
    day_no: state.open?.day_no ?? 12,
    opened_at: state.open?.opened_at ?? '2026-10-10T05:00:00Z',
    opening_float: '1000.00',
    order_count: 2,
    unpaid_orders: opts.unpaid ?? 0,
    gross_collected: '414.00',
    cash_collected: '161.00',
    cash_expenses: expenses.length ? '50.00' : '0.00',
    expenses_total: expenses.length ? '50.00' : '0.00',
    expected_cash: expenses.length ? '1111.00' : '1161.00',
    payment_snapshot: [
      { payment_method_id: M_AMOLE, name: 'Amole', affects_cash_drawer: false, amount: '253.00', count: 1 },
      {
        payment_method_id: M_CASH,
        name: 'Cash Drawer',
        affects_cash_drawer: true,
        amount: '161.00',
        count: 1,
      },
    ],
    expense_snapshot: expenses.length
      ? [{ expense_category_id: EXP_CAT, name: 'Purchases', amount: '50.00', count: 1 }]
      : [],
    station_snapshot: stationSnapshot(12),
    inventory_variance: '0.000',
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
      if (name === 'fn_get_session_context') return r.fulfill(json(200, context()))
      if (name === 'fn_get_open_day') return r.fulfill(json(200, state.open))
      if (name === 'fn_close_day_preview') {
        if (!state.open)
          return r.fulfill(
            json(400, { code: 'P0001', message: 'day_closed', details: 'no open business day' }),
          )
        return r.fulfill(json(200, preview()))
      }
      if (name === 'fn_list_days') {
        const open = state.open
          ? [
              {
                ...closedOld,
                id: state.open.id,
                day_no: state.open.day_no,
                status: 'open',
                closed_at: null,
                closed_by: null,
                order_count: null,
                gross_collected: null,
                cash_collected: null,
                cash_expenses: null,
                expenses_total: null,
                expected_cash: null,
                counted_cash: null,
                cash_variance: null,
                net_profit: null,
                inventory_variance: null,
                station_snapshot: null,
                expense_snapshot: null,
                payment_snapshot: null,
              },
            ]
          : []
        return r.fulfill(json(200, [...open, ...state.days]))
      }
      if (name === 'fn_close_day') {
        const body = req.postDataJSON() as Record<string, unknown>
        calls.close?.push(body)
        const counted = Number(body.p_counted_cash)
        const counts = (body.p_station_counts as Array<{ ingredient_id: string; counted: number }>) ?? []
        const beef = counts.find((c) => c.ingredient_id === ING)?.counted ?? 12
        const p = preview()
        const day = {
          ...closedOld,
          id: DAY,
          day_no: 12,
          opened_at: p.opened_at,
          opening_float: p.opening_float,
          closed_at: '2026-10-10T18:30:00Z',
          order_count: 2,
          gross_collected: '414.00',
          cash_collected: '161.00',
          cash_expenses: p.cash_expenses,
          expenses_total: p.expenses_total,
          expected_cash: p.expected_cash,
          counted_cash: counted.toFixed(2),
          cash_variance: (counted - Number(p.expected_cash)).toFixed(2),
          net_profit: (414 - Number(p.expenses_total)).toFixed(2),
          inventory_variance: (beef - 12).toFixed(3),
          station_snapshot: stationSnapshot(beef),
          expense_snapshot: p.expense_snapshot,
          payment_snapshot: p.payment_snapshot,
          close_note: (body.p_note as string | null) ?? null,
          replayed: false,
        }
        state.open = null
        state.days = [{ ...day, replayed: undefined }, ...state.days]
        return r.fulfill(json(200, day))
      }
      if (name === 'fn_open_day') {
        const body = req.postDataJSON() as Record<string, unknown>
        calls.open?.push(body)
        if (state.open)
          return r.fulfill(json(400, { code: 'P0001', message: 'invalid_state', details: 'day_open' }))
        state.open = { id: DAY2, day_no: 13, opened_at: '2026-10-11T05:00:00Z' }
        return r.fulfill(
          json(200, {
            ...closedOld,
            id: DAY2,
            day_no: 13,
            status: 'open',
            opened_at: state.open.opened_at,
            opening_float: Number(body.p_opening_float).toFixed(2),
            closed_at: null,
            closed_by: null,
            order_count: null,
            gross_collected: null,
            cash_collected: null,
            cash_expenses: null,
            expenses_total: null,
            expected_cash: null,
            counted_cash: null,
            cash_variance: null,
            net_profit: null,
            inventory_variance: null,
            station_snapshot: null,
            expense_snapshot: null,
            payment_snapshot: null,
            replayed: false,
          }),
        )
      }
      return r.fulfill(json(200, null))
    }
    if (name === 'expenses') {
      if (req.method() === 'POST') {
        calls.expense?.push(req.postDataJSON() as Record<string, unknown>)
        expenses.unshift({
          id: '66666666-6666-4666-8666-666666666666',
          amount: '50.00',
          description: 'milk',
          method_name_snapshot: 'Cash Drawer',
          expense_category_id: EXP_CAT,
          created_at: '2026-10-10T09:00:00Z',
        })
        return r.fulfill({ status: 201, headers: CORS, body: '' })
      }
      return r.fulfill(json(200, expenses))
    }
    if (name === 'expense_categories')
      return r.fulfill(
        json(200, [
          { id: EXP_CAT, name: 'Purchases', color: null, icon: null, sort_order: 1, is_active: true },
        ]),
      )
    if (name === 'payment_methods')
      return r.fulfill(
        json(200, [
          {
            id: M_CASH,
            name: 'Cash Drawer',
            description: null,
            color: null,
            icon: null,
            sort_order: 1,
            is_active: true,
            affects_cash_drawer: true,
            requires_reference: false,
          },
          {
            id: M_AMOLE,
            name: 'Amole',
            description: null,
            color: null,
            icon: null,
            sort_order: 2,
            is_active: true,
            affects_cash_drawer: false,
            requires_reference: true,
          },
        ]),
      )
    if (name === 'restaurants') return r.fulfill(json(200, { timezone: 'Africa/Addis_Ababa' }))
    return r.fulfill(json(200, []))
  })
  return calls
}

test('close / reopen gate: expense, cash and station counts, variance, close, new day, frozen history', async ({
  page,
}) => {
  const calls = await setup(page)
  await page.goto('/r/demo-cafe/day-close')
  await expect(page.getByRole('heading', { level: 1, name: 'Day close' })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Day close' }),
  ).toBeVisible()

  // expense of the day (category and method are runtime rows)
  await page.getByLabel('Category').selectOption({ label: 'Purchases' })
  await page.getByLabel('Paid with').selectOption({ label: 'Cash Drawer' })
  await page.getByLabel('Amount (ETB)').fill('50')
  await page.getByLabel('Description (optional)').fill('milk')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Expenses of the day' })).toContainText('Purchases')
  expect(calls.expense?.[0]).toEqual({
    restaurant_id: RID,
    expense_category_id: EXP_CAT,
    payment_method_id: M_CASH,
    amount: 50,
    description: 'milk',
  })

  // the close sheet: expected = float + cash - cash expenses (server figure)
  const close = page.getByRole('region', { name: 'Close business day 12' })
  await expect(close).toContainText('ETB 1,111.00')
  await expect(close.getByRole('group', { name: /Grill/ })).toContainText('Beef')
  await close.getByLabel('Counted cash (ETB)').fill('1100')
  await expect(close).toContainText('Variance: ETB -11.00')
  await close.getByLabel('Counted Beef (kg)').fill('10.5')
  await expect(close.getByRole('group', { name: /Grill/ })).toContainText('-1.5')
  await close.getByLabel('Note (optional)').fill('short by 11')

  // confirm, then close
  await close.getByRole('button', { name: 'Close the day' }).click()
  const dialog = page.getByRole('dialog', { name: 'Close business day 12?' })
  await expect(dialog).toContainText('frozen')
  await dialog.getByRole('button', { name: 'Close and freeze' }).click()
  const sheet = page.getByRole('region', { name: 'Balance sheet day 12' })
  await expect(sheet).toContainText('ETB -11.00')
  await expect(sheet).toContainText('Amole')
  await expect(sheet).toContainText('Purchases')
  await expect(sheet).toContainText('Grill')
  expect(calls.close).toHaveLength(1)
  const sent = calls.close?.[0] ?? {}
  expect(sent).toMatchObject({
    p_counted_cash: 1100,
    p_station_counts: [{ ingredient_id: ING, counted: 10.5 }],
    p_note: 'short by 11',
  })
  expect(String(sent.p_idempotency_key)).toMatch(/^[0-9a-f-]{36}$/)
  // intents only: never a tenant id, an expected figure or a variance
  expect(Object.keys(sent).sort()).toEqual([
    'p_counted_cash',
    'p_idempotency_key',
    'p_note',
    'p_station_counts',
  ])

  // a new day (the only way forward)
  await sheet.getByRole('button', { name: 'Done' }).click()
  const open = page.getByRole('region', { name: 'Open a new business day' })
  await open.getByLabel('Opening float (ETB)').fill('2000')
  await open.getByRole('button', { name: 'Open day' }).click()
  await expect(page.getByRole('region', { name: 'Close business day 13' })).toBeVisible()
  expect(calls.open?.[0]).toMatchObject({ p_opening_float: 2000 })
  expect(Object.keys(calls.open?.[0] ?? {}).sort()).toEqual(['p_idempotency_key', 'p_opening_float'])

  // history: the closed day stays readable with its frozen figures; there is no "reopen" on a closed day
  const history = page.getByRole('table', { name: 'Business days' })
  const row12 = history.getByRole('row').filter({ has: page.getByRole('cell', { name: '12', exact: true }) })
  await expect(row12).toContainText('ETB -11.00')
  await expect(history).not.toContainText(/reopen/i)
  await row12.getByRole('button', { name: 'Balance sheet' }).click()
  await expect(page.getByRole('region', { name: 'Balance sheet day 12' })).toContainText('short by 11')
})

test('unpaid orders block the close (button disabled, reason shown)', async ({ page }) => {
  const calls = await setup(page, { unpaid: 2 })
  await page.goto('/r/demo-cafe/day-close')
  const close = page.getByRole('region', { name: 'Close business day 12' })
  await expect(close.getByRole('alert')).toContainText('2 order(s) are still unpaid')
  await close.getByLabel('Counted cash (ETB)').fill('1161')
  await expect(close.getByRole('button', { name: 'Close the day' })).toBeDisabled()
  expect(calls.close).toHaveLength(0)
})

test('without day_close.execute: no nav entry and the route is forbidden', async ({ page }) => {
  await setup(page, { permissions: ['reports.view', 'dashboard.view'] })
  await page.goto('/r/demo-cafe/day-close')
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible()
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Day close' }),
  ).toHaveCount(0)
})
