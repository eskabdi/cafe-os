import { expect, test, type Page } from '@playwright/test'

// Cashier (Phase 6) against mocked Supabase (page.route). Payment method names (Amole, Cash Drawer) are runtime data only: the
// code knows none of them; the flags on the row (requires_reference, affects_cash_drawer) drive the form. The payment call
// must be an intent (order id, method id, reference, amount received, key): never the amount to charge.
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
const PAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function setup(page: Page, opts: { permissions?: string[]; failFirst?: boolean } = {}) {
  const paid: Array<Record<string, unknown>> = []
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'c.staff.cafeos.invalid',
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
    user: { id: 'u-1', first_name: 'Hana', short_name: 'Hana Tesfaye', username: 'hana' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: opts.permissions ?? ['payments.create', 'payments.view', 'orders.view', 'orders.view_all'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: DAY, day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
  }
  const order = {
    id: ORDER,
    order_no: 'ORD-0042',
    status: 'ready',
    order_type: 'dine-in',
    table_label_snapshot: 'T7',
    created_by_name_snapshot: 'Yonas Alemu',
    total: '173.65',
    created_at: '2026-10-10T06:00:00Z',
  }
  const detail = {
    id: ORDER,
    order_no: 'ORD-0042',
    status: 'ready',
    payment_status: 'unpaid',
    subtotal: '151.00',
    vat_rate_snapshot: '15.00',
    vat_amount: '22.65',
    total: '173.65',
    order_items: [
      {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        name_snapshot: 'Baklava',
        qty: 1,
        price_snapshot: 80,
        item_status: 'ready',
      },
      {
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        name_snapshot: 'Macchiato',
        qty: 2,
        price_snapshot: '35.50',
        item_status: 'ready',
      },
    ],
  }
  const methods = [
    {
      id: M_CASH,
      name: 'Cash Drawer',
      description: null,
      color: '#16a34a',
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
      color: '#7c3aed',
      icon: null,
      sort_order: 2,
      is_active: true,
      affects_cash_drawer: false,
      requires_reference: true,
    },
  ]
  const receipt = (method: string, ref: string | null, tendered: number | null) => ({
    payment_id: PAY,
    receipt_no: 'RCT-0007',
    kind: 'order_payment',
    amount: 173.65,
    created_at: '2026-10-10T16:05:00Z',
    method,
    affects_cash_drawer: method === 'Cash Drawer',
    reference: ref,
    reversed_payment_id: null,
    reversed: false,
    received_by: 'Hana Tesfaye',
    restaurant: {
      name: 'Demo Cafe',
      phone: null,
      address: 'Bole, Addis Ababa',
      tin: '0012345678',
      timezone: 'Africa/Addis_Ababa',
    },
    order: {
      id: ORDER,
      order_no: 'ORD-0042',
      order_type: 'dine-in',
      table_label: 'T7',
      taken_by: 'Yonas Alemu',
      created_at: '2026-10-10T06:00:00Z',
      subtotal: 151,
      vat_rate: 15,
      vat_amount: 22.65,
      total: 173.65,
      items: [
        { name: 'Baklava', qty: 1, price: 80, line_total: 80 },
        { name: 'Macchiato', qty: 2, price: 35.5, line_total: 71 },
      ],
    },
    tendered,
    change: tendered === null ? null : Math.round((tendered - 173.65) * 100) / 100,
    replayed: false,
  })
  let calls = 0
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
      if (name === 'fn_confirm_payment') {
        const body = req.postDataJSON() as Record<string, unknown>
        paid.push(body)
        calls++
        if (opts.failFirst && calls === 1)
          return r.fulfill({ status: 503, headers: CORS, body: 'unavailable' })
        const m = methods.find((x) => x.id === body.p_payment_method_id)
        return r.fulfill(
          json(
            200,
            receipt(
              m?.name ?? '?',
              (body.p_reference as string | null) ?? null,
              (body.p_tendered as number | null) ?? null,
            ),
          ),
        )
      }
      return r.fulfill(json(200, null))
    }
    if (name === 'payment_methods') return r.fulfill(json(200, methods))
    if (name === 'orders')
      return r.fulfill(
        json(200, url.searchParams.has('id') ? detail : paid.length && !opts.failFirst ? [] : [order]),
      )
    if (name === 'payments') return r.fulfill(json(200, []))
    return r.fulfill(json(200, []))
  })
  return paid
}

test('pays an order with a method created as data (Amole): reference required, intent only, printable receipt', async ({
  page,
}) => {
  const paid = await setup(page)
  await page.goto('/r/demo-cafe/cashier')
  await expect(page.getByRole('heading', { level: 1, name: 'Cashier' })).toBeVisible()
  await page
    .getByRole('list', { name: 'Unpaid orders' })
    .getByRole('button', { name: /ORD-0042/ })
    .click()
  await expect(page.getByRole('list', { name: 'Order lines' })).toContainText('Macchiato')
  await page.getByRole('radio', { name: 'Amole' }).click()
  const confirm = page.getByRole('button', { name: /Confirm payment/ })
  await expect(confirm).toBeDisabled() // the row says a reference is required
  await page.getByLabel('Reference').fill('AM-998877')
  await confirm.click()
  const receipt = page.getByRole('article', { name: 'Receipt RCT-0007' })
  await expect(receipt).toBeVisible()
  await expect(receipt).toContainText('173.65')
  await expect(receipt).toContainText('AM-998877')
  await expect(receipt).toContainText('1:05 ማታ') // Ethiopian clock, Arabic numerals
  await expect(page.getByRole('button', { name: 'Print' })).toBeVisible()
  expect(paid).toHaveLength(1)
  const body = paid[0] as Record<string, unknown>
  expect(body.p_order_id).toBe(ORDER)
  expect(body.p_payment_method_id).toBe(M_AMOLE)
  expect(body.p_reference).toBe('AM-998877')
  expect(body.p_tendered).toBeNull()
  expect(Object.keys(body).sort()).toEqual([
    'p_idempotency_key',
    'p_order_id',
    'p_payment_method_id',
    'p_reference',
    'p_tendered',
  ])
})

test('cash-drawer method: change preview, and a retry after a failure reuses the same idempotency key', async ({
  page,
}) => {
  const paid = await setup(page, { failFirst: true })
  await page.goto('/r/demo-cafe/cashier')
  await page
    .getByRole('list', { name: 'Unpaid orders' })
    .getByRole('button', { name: /ORD-0042/ })
    .click()
  await page.getByRole('radio', { name: 'Cash Drawer' }).click()
  await page.getByLabel('Amount received (ETB)').fill('200')
  await expect(page.getByText('Change:')).toContainText('26.35')
  await page.getByRole('button', { name: /Confirm payment/ }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('Amount received (ETB)')).toBeDisabled() // outcome unknown: frozen
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('article', { name: 'Receipt RCT-0007' })).toContainText('26.35')
  expect(paid).toHaveLength(2)
  expect(paid[0]?.p_idempotency_key).toBe(paid[1]?.p_idempotency_key)
  expect(paid[1]?.p_tendered).toBe(200)
})

test('without payments.create the cashier is not authorised', async ({ page }) => {
  await setup(page, { permissions: ['orders.view'] })
  await page.goto('/r/demo-cafe/cashier')
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible()
})
