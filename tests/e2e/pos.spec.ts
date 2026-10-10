import { expect, test, type Page } from '@playwright/test'

// Waiter POS (Phase 4) against mocked Supabase (page.route). Category, item and table names are runtime data only: the code
// knows none of them. The submitted payload must be an intent (ids, quantities, notes): no price, no total.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const RID = '99999999-9999-4999-8999-999999999999'
const CAT_HOT = '11111111-1111-4111-8111-111111111111'
const CAT_SWEET = '22222222-2222-4222-8222-222222222222'
const ST = '33333333-3333-4333-8333-333333333333'
const ITEM_A = '44444444-4444-4444-8444-444444444444'
const ITEM_B = '55555555-5555-4555-8555-555555555555'
const TABLE = '66666666-6666-4666-8666-666666666666'

async function setup(page: Page, opts: { openDay?: boolean; failFirst?: boolean } = {}) {
  const submitted: Array<Record<string, unknown>> = []
  const user = { id: 'u-1', aud: 'authenticated', role: 'authenticated', email: 'w.staff.cafeos.invalid', app_metadata: { staff: true }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
  const session = { access_token: jwt, refresh_token: 'r', expires_at: exp, expires_in: 3600, token_type: 'bearer', user }
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session)],
  )
  const json = (status: number, body: unknown) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const context = {
    user: { id: 'u-1', first_name: 'Yonas', short_name: 'Yonas', username: 'yonas' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: ['orders.create', 'orders.view'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: opts.openDay === false ? null : { id: '77777777-7777-4777-8777-777777777777', day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
  }
  const rows: Record<string, unknown[]> = {
    categories: [
      { id: CAT_HOT, name: 'Hot Drinks', description: null, color: '#b45309', icon: null, sort_order: 1, is_active: true },
      { id: CAT_SWEET, name: 'Desserts', description: null, color: null, icon: null, sort_order: 2, is_active: true },
    ],
    menu_items: [
      { id: ITEM_A, name: 'Macchiato', description: null, category_id: CAT_HOT, station_id: ST, price: '35.50', emoji: null, image_path: null, sort_order: 1, is_active: true },
      { id: ITEM_B, name: 'Baklava', description: null, category_id: CAT_SWEET, station_id: ST, price: 80, emoji: null, image_path: null, sort_order: 2, is_active: true },
    ],
    tables: [{ id: TABLE, label: 'T7', status: 'available', capacity: 4, sort_order: 1, is_active: true }],
    orders: [],
  }
  let calls = 0
  await page.route('**/auth/v1/**', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, user))))
  await page.route('**/rest/v1/**', (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const url = new URL(req.url())
    const parts = url.pathname.split('/')
    const name = parts.pop() ?? ''
    if (parts.includes('rpc')) {
      if (name === 'fn_get_session_context') return r.fulfill(json(200, context))
      if (name === 'fn_get_open_day') return r.fulfill(json(200, context.open_day))
      if (name === 'fn_submit_order') {
        submitted.push(req.postDataJSON() as Record<string, unknown>)
        calls++
        if (opts.failFirst && calls === 1) return r.fulfill({ status: 503, headers: CORS, body: 'unavailable' })
        return r.fulfill(
          json(200, {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', order_no: 'ORD-0042', source: 'staff', order_type: 'dine-in', status: 'pending',
            payment_status: 'unpaid', table_id: TABLE, table_label: 'T7', subtotal: '151.00', vat_rate: '15.00', vat_amount: '22.65',
            total: '173.65', created_at: '2026-10-10T06:00:00Z', items: [], replayed: calls > 1,
          }),
        )
      }
      return r.fulfill(json(200, null))
    }
    return r.fulfill(json(200, rows[name] ?? []))
  })
  return submitted
}

test('builds an order from tenant rows and sends an intent; the server totals are shown', async ({ page }) => {
  const submitted = await setup(page)
  await page.goto('/r/demo-cafe/pos')
  await expect(page.getByRole('heading', { level: 1, name: 'New order' })).toBeVisible()
  await page.getByRole('button', { name: 'Desserts' }).click()
  await expect(page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Macchiato/ })).toHaveCount(0)
  await page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Baklava/ }).click()
  await page.getByRole('button', { name: 'All' }).click()
  await page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Macchiato/ }).click()
  await page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Macchiato/ }).click()
  await expect(page.getByTestId('pos-subtotal')).toContainText('151.00')
  await page.getByLabel('Table').selectOption(TABLE)
  await page.getByRole('button', { name: 'Send order' }).click()
  await expect(page.getByTestId('pos-last-order')).toContainText('ORD-0042')
  await expect(page.getByTestId('pos-last-order')).toContainText('173.65')
  expect(submitted).toHaveLength(1)
  const body = submitted[0] as { p_items: unknown; p_idempotency_key: string; p_table_id: string }
  expect(body.p_items).toEqual([
    { menu_item_id: ITEM_B, qty: 1, note: null },
    { menu_item_id: ITEM_A, qty: 2, note: null },
  ])
  expect(JSON.stringify(body)).not.toMatch(/price|total|subtotal/)
  expect(body.p_table_id).toBe(TABLE)
})

test('a retry after a failed send reuses the same idempotency key', async ({ page }) => {
  const submitted = await setup(page, { failFirst: true })
  await page.goto('/r/demo-cafe/pos')
  await page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Macchiato/ }).click()
  await page.getByLabel('Order type').selectOption('takeaway')
  await page.getByRole('button', { name: 'Send order' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  // the outcome is unknown: the cart is frozen and the SAME key is resent
  await expect(page.getByLabel('Order type')).toBeDisabled()
  await page.getByRole('button', { name: 'Send again' }).click()
  await expect(page.getByTestId('pos-last-order')).toContainText('ORD-0042')
  expect(submitted).toHaveLength(2)
  expect(submitted[0]?.p_idempotency_key).toBe(submitted[1]?.p_idempotency_key)
})

test('without an open business day the order cannot be sent', async ({ page }) => {
  await setup(page, { openDay: false })
  await page.goto('/r/demo-cafe/pos')
  await expect(page.getByText('No business day is open.', { exact: false })).toBeVisible()
  await page.getByRole('list', { name: 'Menu' }).getByRole('button', { name: /Macchiato/ }).click()
  await expect(page.getByRole('button', { name: 'Send order' })).toBeDisabled()
})
