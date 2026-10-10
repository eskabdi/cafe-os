import { expect, test, type Page } from '@playwright/test'

// Generic station display (Phase 5) against mocked Supabase. "Grill" exists only as a data row: no code knows the name.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const RID = '99999999-9999-4999-8999-999999999999'
const GRILL = '11111111-1111-4111-8111-111111111111'
const O1 = '22222222-2222-4222-8222-222222222222'
const O2 = '33333333-3333-4333-8333-333333333333'
const DAY = '44444444-4444-4444-8444-444444444444'

async function setup(page: Page) {
  const calls: Array<Record<string, unknown>> = []
  const user = { id: 'u-1', aud: 'authenticated', role: 'authenticated', email: 'k.staff.cafeos.invalid', app_metadata: { staff: true }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
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
    user: { id: 'u-1', first_name: 'Abebe', short_name: 'Abebe', username: 'abebe' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: ['orders.view'],
    station_ids: [GRILL],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: DAY, day_no: 3, opened_at: '2026-10-10T05:00:00Z' },
  }
  const now = new Date().toISOString()
  const old = new Date(Date.now() - 25 * 60_000).toISOString()
  let status1 = 'pending'
  const rows = () => [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', order_id: O1, line_no: 1, name_snapshot: 'Mixed Grill', qty: 2, note: 'well done', item_status: status1,
      orders: { order_no: 'ORD-0007', table_label_snapshot: 'T3', order_type: 'dine-in', status: 'submitted', created_at: old, day_session_id: DAY } },
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', order_id: O2, line_no: 1, name_snapshot: 'Kitfo', qty: 1, note: null, item_status: 'pending',
      orders: { order_no: 'ORD-0008', table_label_snapshot: null, order_type: 'takeaway', status: 'submitted', created_at: now, day_session_id: DAY } },
  ]
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
      if (name === 'fn_set_station_items_status') {
        const body = req.postDataJSON() as Record<string, unknown>
        calls.push(body)
        status1 = String(body.p_status)
        return r.fulfill(json(200, { id: O1 }))
      }
      return r.fulfill(json(200, null))
    }
    if (name === 'stations') return r.fulfill(json(200, [{ id: GRILL, name: 'Grill', description: null, color: '#ea580c', icon: null, sort_order: 1, is_active: true }]))
    if (name === 'order_items') return r.fulfill(json(200, rows()))
    return r.fulfill(json(200, []))
  })
  return calls
}

test('a station created as data shows its tickets, oldest first, and drives start / ready', async ({ page }) => {
  const calls = await setup(page)
  await page.goto(`/r/demo-cafe/stations/${GRILL}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Grill' })).toBeVisible()
  const tickets = page.getByTestId('kds-ticket')
  await expect(tickets).toHaveCount(2)
  await expect(tickets.first()).toContainText('ORD-0007')
  await expect(tickets.first()).toContainText('well done')
  await tickets.first().getByRole('button', { name: 'Start' }).click()
  await expect(tickets.first().getByRole('button', { name: 'Ready' })).toBeVisible()
  await tickets.first().getByRole('button', { name: 'Ready' }).click()
  await expect(tickets.first()).toContainText('Ready')
  expect(calls.map((c) => c.p_status)).toEqual(['preparing', 'ready'])
  expect(calls.every((c) => c.p_station_id === GRILL && c.p_order_id === O1)).toBe(true)
  // no cancel without orders.cancel
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
})
