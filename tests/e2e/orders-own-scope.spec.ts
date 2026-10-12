import { expect, test, type Page } from '@playwright/test'

// Orders scoped to the signed-in user (migration 0041, docs/note.md task 1) against mocked Supabase (page.route).
// A restricted waiter (orders.view + orders.cancel, WITHOUT orders.view_all / orders.cancel_any) gets "My orders": the list is
// requested for created_by = the signed-in user, and Cancel is offered only on own untouched, unpaid orders. The rule is keyed on
// permissions only; the role name is runtime data. RLS (orders_select) and fn_cancel_order enforce the same rule server-side.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const UID = 'u-1'
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function setup(page: Page, permissions: string[]) {
  const ordersUrls: string[] = []
  const cancelled: Array<Record<string, unknown>> = []
  const user = {
    id: UID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'w.staff.cafeos.invalid',
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
    user: { id: UID, first_name: 'Yonas', short_name: 'Yonas', username: 'yonas' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions,
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: '77777777-7777-4777-8777-777777777777', day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
  }
  const order = (id: string, no: string, createdBy: string) => ({
    id,
    order_no: no,
    status: 'submitted',
    payment_status: 'unpaid',
    order_type: 'takeaway',
    table_label_snapshot: null,
    total: '57.50',
    created_at: '2026-10-10T06:00:00Z',
    created_by: createdBy,
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
      if (name === 'fn_cancel_order') {
        cancelled.push(req.postDataJSON() as Record<string, unknown>)
        return r.fulfill(
          json(200, {
            order_id: OWN,
            order_no: 'ORD-0007',
            status: 'cancelled',
            reversed_movements: 0,
            already_cancelled: false,
          }),
        )
      }
      return r.fulfill(json(200, null))
    }
    if (name === 'orders') {
      ordersUrls.push(req.url())
      // a row of someone else (as an orders.view_all caller would get it) must never carry a Cancel button without cancel_any
      return r.fulfill(json(200, [order(OWN, 'ORD-0007', UID), order(OTHER, 'ORD-0008', 'u-2')]))
    }
    return r.fulfill(json(200, []))
  })
  return { ordersUrls, cancelled }
}

test('a restricted waiter sees "My orders" (filtered by own user id) and cancels only own orders', async ({
  page,
}) => {
  const { ordersUrls, cancelled } = await setup(page, ['orders.create', 'orders.view', 'orders.cancel'])
  await page.goto('/r/demo-cafe/pos')
  const summary = page.getByText(/^My orders \(\d+\)$/)
  await expect(summary).toBeVisible()
  expect(ordersUrls.some((u) => new URL(u).searchParams.get('created_by') === `eq.${UID}`)).toBe(true)
  await summary.click()
  const list = page.getByRole('list', { name: 'My orders' })
  await expect(list.getByRole('button', { name: 'Cancel order ORD-0007' })).toBeVisible()
  await expect(list.getByRole('button', { name: 'Cancel order ORD-0008' })).toHaveCount(0)
  await list.getByRole('button', { name: 'Cancel order ORD-0007' }).click()
  await page.getByRole('button', { name: 'Cancel the order' }).click()
  await expect(page.getByText('Order ORD-0007 cancelled')).toBeVisible()
  expect(cancelled).toEqual([{ p_order_id: OWN, p_reason: null }])
})

test('orders.view_all + orders.cancel_any: the full list, no user filter, Cancel on every untouched order', async ({
  page,
}) => {
  const { ordersUrls } = await setup(page, [
    'orders.create',
    'orders.view',
    'orders.view_all',
    'orders.cancel',
    'orders.cancel_any',
  ])
  await page.goto('/r/demo-cafe/pos')
  const summary = page.getByText(/^Today’s orders \(\d+\)$/)
  await expect(summary).toBeVisible()
  expect(ordersUrls.every((u) => !new URL(u).searchParams.has('created_by'))).toBe(true)
  await summary.click()
  await expect(page.getByRole('button', { name: 'Cancel order ORD-0008' })).toBeVisible()
})
