import { expect, test, type Page } from '@playwright/test'

// Phase 10 settings: the generic configuration page and the database's dependency guards, against mocked Supabase (page.route).
// The guard answers (in_use + counted detail) are the server's; the page must explain the blocking dependency, offer
// deactivation, and send only the closed-list domain + row id. Row names are runtime data only.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const S_USED = '11111111-1111-4111-8111-111111111111'
const S_SPARE = '22222222-2222-4222-8222-222222222222'
const M_ONLY = '33333333-3333-4333-8333-333333333333'

async function setup(page: Page, opts: { permissions?: string[] } = {}) {
  const rpcCalls: Array<{ fn: string; body: Record<string, unknown> }> = []
  const patches: Array<Record<string, unknown>> = []
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'a.staff.cafeos.invalid',
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
  const context = {
    user: { id: 'u-1', first_name: 'Selam', short_name: 'Selam', username: 'selam' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: opts.permissions ?? ['config.manage'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: null,
  }
  const stations = [
    {
      id: S_USED,
      name: 'Grill',
      description: null,
      color: '#ea580c',
      icon: 'chef-hat',
      sort_order: 1,
      is_active: true,
    },
    {
      id: S_SPARE,
      name: 'Spare Bar',
      description: null,
      color: null,
      icon: null,
      sort_order: 2,
      is_active: true,
    },
  ]
  const methods = [
    {
      id: M_ONLY,
      name: 'Amole',
      description: null,
      color: null,
      icon: null,
      sort_order: 1,
      is_active: true,
      affects_cash_drawer: false,
      requires_reference: true,
    },
  ]
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
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>
      if (name === 'fn_get_session_context') return r.fulfill(json(200, context))
      if (name === 'fn_get_open_day') return r.fulfill(json(200, null))
      rpcCalls.push({ fn: name, body })
      if (name === 'fn_config_usage')
        return r.fulfill(
          json(
            200,
            body.p_id === S_USED
              ? {
                  menu_items: 2,
                  active_menu_items: 2,
                  ingredients: 1,
                  active_ingredients: 1,
                  order_items: 0,
                  active_open_order_items: 0,
                  stock_movements: 0,
                  role_access: 0,
                }
              : {
                  menu_items: 0,
                  active_menu_items: 0,
                  ingredients: 0,
                  active_ingredients: 0,
                  order_items: 0,
                  active_open_order_items: 0,
                  stock_movements: 0,
                  role_access: 0,
                  payments: 0,
                  expenses: 0,
                  vouchers: 0,
                },
          ),
        )
      if (name === 'fn_delete_config_row') {
        if (body.p_domain === 'payment_methods')
          return r.fulfill(
            json(400, { code: 'P0001', message: 'in_use', details: 'last_active_method', hint: null }),
          )
        const i = stations.findIndex((s) => s.id === body.p_id)
        if (i >= 0) stations.splice(i, 1)
        return r.fulfill(json(200, { deleted: true, domain: body.p_domain, id: body.p_id }))
      }
      return r.fulfill(json(200, null))
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as Record<string, unknown>
      patches.push({ table: name, id: url.searchParams.get('id'), ...body })
      if (name === 'payment_methods' && body.is_active === false)
        return r.fulfill(
          json(400, { code: 'P0001', message: 'in_use', details: 'last_active_method', hint: null }),
        )
      const row = (name === 'stations' ? stations : methods).find(
        (s) => `eq.${s.id}` === url.searchParams.get('id'),
      )
      if (row) Object.assign(row, body)
      return r.fulfill({ status: 204, headers: { ...CORS, 'content-range': '0-0/1' } })
    }
    if (name === 'stations') return r.fulfill(json(200, stations))
    if (name === 'payment_methods') return r.fulfill(json(200, methods))
    return r.fulfill(json(200, []))
  })
  return { rpcCalls, patches }
}

test('a used station deactivates but cannot be deleted: the page names what uses it; an unused one is deleted', async ({
  page,
}) => {
  const { rpcCalls, patches } = await setup(page)
  await page.goto('/r/demo-cafe/settings/stations')
  await expect(page.getByRole('heading', { level: 1, name: 'Stations' })).toBeVisible()
  const list = page.getByRole('list', { name: 'All stations' })
  await expect(list.getByTestId('config-row')).toHaveCount(2)

  // deactivation is the supported path even while items use the station (history keeps snapshots)
  await page.getByRole('button', { name: 'Deactivate Grill' }).click()
  await expect(list.getByTestId('config-row').first()).toContainText('Inactive')
  expect(patches[0]).toMatchObject({ table: 'stations', id: `eq.${S_USED}`, is_active: false })

  // delete guard: usage is checked first, the blocker is shown and Delete stays disabled
  await page.getByRole('button', { name: 'Delete Grill' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('It cannot be deleted: it is used by 2 menu items, 1 ingredients')
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  expect(rpcCalls.filter((c) => c.fn === 'fn_delete_config_row')).toHaveLength(0)

  // an unused row is deleted through the RPC with the closed-list domain and the id only
  await page.getByRole('button', { name: 'Delete Spare Bar' }).click()
  await expect(page.getByRole('dialog')).toContainText('Nothing refers to this station')
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(list.getByTestId('config-row')).toHaveCount(1)
  const del = rpcCalls.find((c) => c.fn === 'fn_delete_config_row')
  expect(del?.body).toEqual({ p_domain: 'stations', p_id: S_SPARE })
})

test('the last active payment method is kept: deactivation and a server-refused delete are both explained', async ({
  page,
}) => {
  await setup(page)
  await page.goto('/r/demo-cafe/settings/payment-methods')
  await expect(page.getByRole('heading', { level: 1, name: 'Payment methods' })).toBeVisible()
  await page.getByRole('button', { name: 'Deactivate Amole' }).click()
  await expect(page.getByText(/only active payment method/).first()).toBeVisible()
  await page.getByRole('button', { name: 'Delete Amole' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('only active payment method')
})

test('without config.manage the settings pages are not authorised and not in the navigation', async ({
  page,
}) => {
  await setup(page, { permissions: ['orders.create'] })
  await page.goto('/r/demo-cafe/settings/stations')
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Payment methods' })).toHaveCount(0)
})
