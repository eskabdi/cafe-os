import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'

// The mandatory GENERALIZATION test (Phase 10 gate: "all six domains dynamically editable, no redeploy"). Station Grill, category
// Desserts, payment method Amole, table area + table, and the item are created through the settings / menu UI at runtime; the
// signed-in role is Runner (a custom role row). The full order -> station board -> payment flow then runs on those rows. No
// application code knows any of these names: they exist only as rows in this in-memory mock of Supabase (page.route), which
// stands in for the database (PostgREST + RPCs) exactly as the other specs do.
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

type Row = Record<string, unknown> & { id: string }

async function setup(page: Page) {
  const db: Record<string, Row[]> = {
    stations: [],
    categories: [],
    payment_methods: [],
    table_areas: [],
    tables: [],
    expense_categories: [],
    menu_items: [],
    orders: [],
    order_items: [],
  }
  const calls: Array<{ fn: string; body: Record<string, unknown> }> = []
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'r.staff.cafeos.invalid',
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
    user: { id: 'u-1', first_name: 'Hana', short_name: 'Hana Tesfaye', username: 'hana' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: [
      'config.manage',
      'tables.manage',
      'menu.view',
      'menu.manage',
      'orders.create',
      'orders.view',
      'orders.view_all',
      'payments.create',
      'payments.view',
    ],
    // station access comes from role_station_access rows: here every station of the tenant (by id)
    station_ids: (db.stations ?? []).map((s) => s.id),
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: DAY, day_no: 1, opened_at: '2026-10-10T05:00:00Z' },
  })
  /** PostgREST-style `col=eq.value` filters on plain columns (embedded / operator filters are ignored by this mock). */
  const filter = (rows: Row[], params: URLSearchParams) =>
    rows.filter((r) =>
      [...params.entries()].every(
        ([k, v]) => k.includes('.') || !v.startsWith('eq.') || !(k in r) || String(r[k]) === v.slice(3),
      ),
    )
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
      if (name === 'fn_get_session_context') return r.fulfill(json(200, context()))
      if (name === 'fn_get_open_day') return r.fulfill(json(200, context().open_day))
      calls.push({ fn: name, body })
      if (name === 'fn_create_menu_item') {
        const item: Row = {
          id: randomUUID(),
          name: body.p_name,
          description: null,
          category_id: body.p_category_id,
          station_id: body.p_station_id,
          price: body.p_price,
          emoji: null,
          image_path: null,
          sort_order: body.p_sort_order,
          is_active: true,
        }
        db.menu_items?.push(item)
        return r.fulfill(json(200, item))
      }
      if (name === 'fn_submit_order') {
        // the "server" prices the intent from its own rows
        const lines = (body.p_items as Array<{ menu_item_id: string; qty: number }>).map((l, i) => {
          const m = db.menu_items?.find((x) => x.id === l.menu_item_id) as Row
          const st = db.stations?.find((s) => s.id === m.station_id) as Row
          return {
            id: randomUUID(),
            line_no: i + 1,
            menu_item_id: m.id,
            name: m.name,
            price: Number(m.price),
            qty: l.qty,
            line_total: Number(m.price) * l.qty,
            station_id: st.id,
            station_name: st.name,
            item_status: 'pending',
            note: null,
          }
        })
        const subtotal = lines.reduce((a, l) => a + l.line_total, 0)
        const vat = Math.round(subtotal * 15) / 100
        const table = db.tables?.find((t) => t.id === body.p_table_id)
        const order: Row = {
          id: randomUUID(),
          order_no: 'ORD-0001',
          source: 'staff',
          order_type: body.p_order_type,
          status: 'pending',
          payment_status: 'unpaid',
          table_id: body.p_table_id,
          table_label: table?.label ?? null,
          table_label_snapshot: table?.label ?? null,
          created_by_name_snapshot: 'Hana Tesfaye',
          subtotal,
          vat_rate: 15,
          vat_rate_snapshot: 15,
          vat_amount: vat,
          total: subtotal + vat,
          created_at: new Date().toISOString(),
          day_session_id: DAY,
        }
        db.orders?.push(order)
        for (const l of lines)
          db.order_items?.push({ ...l, order_id: order.id, name_snapshot: l.name, price_snapshot: l.price })
        return r.fulfill(json(200, { ...order, items: lines, replayed: false }))
      }
      if (name === 'fn_set_station_items_status') {
        for (const l of db.order_items ?? [])
          if (l.order_id === body.p_order_id && l.station_id === body.p_station_id)
            l.item_status = body.p_status
        return r.fulfill(json(200, { id: body.p_order_id }))
      }
      if (name === 'fn_confirm_payment') {
        const o = db.orders?.find((x) => x.id === body.p_order_id) as Row
        const m = db.payment_methods?.find((x) => x.id === body.p_payment_method_id) as Row
        o.payment_status = 'paid'
        return r.fulfill(
          json(200, {
            payment_id: randomUUID(),
            receipt_no: 'RCT-0001',
            kind: 'order_payment',
            amount: o.total,
            created_at: new Date().toISOString(),
            method: m.name,
            affects_cash_drawer: m.affects_cash_drawer,
            reference: body.p_reference,
            reversed_payment_id: null,
            reversed: false,
            received_by: 'Hana Tesfaye',
            restaurant: { name: 'Demo Cafe', timezone: 'Africa/Addis_Ababa' },
            order: {
              id: o.id,
              order_no: o.order_no,
              order_type: o.order_type,
              table_label: o.table_label,
              taken_by: 'Hana Tesfaye',
              created_at: o.created_at,
              subtotal: o.subtotal,
              vat_rate: 15,
              vat_amount: o.vat_amount,
              total: o.total,
              items: (db.order_items ?? [])
                .filter((l) => l.order_id === o.id)
                .map((l) => ({
                  name: l.name_snapshot,
                  qty: l.qty,
                  price: l.price,
                  line_total: l.line_total,
                })),
            },
            tendered: null,
            change: null,
            replayed: false,
          }),
        )
      }
      return r.fulfill(json(200, null))
    }
    const rows = db[name]
    if (!rows) return r.fulfill(json(200, []))
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as Record<string, unknown>
      expect(body.restaurant_id).toBe(RID)
      rows.push({
        id: randomUUID(),
        description: null,
        color: null,
        icon: null,
        is_active: true,
        status: 'available',
        ...body,
      })
      return r.fulfill({ status: 201, headers: CORS })
    }
    if (req.method() === 'PATCH') {
      for (const row of filter(rows, url.searchParams)) Object.assign(row, req.postDataJSON())
      return r.fulfill({ status: 204, headers: { ...CORS, 'content-range': '0-0/1' } })
    }
    let out = filter(rows, url.searchParams)
    if (name === 'order_items') {
      out = out
        .filter((l) => ['pending', 'preparing', 'ready'].includes(String(l.item_status)))
        .map((l) => ({ ...l, orders: db.orders?.find((o) => o.id === l.order_id) }))
    }
    if (name === 'orders') {
      if (url.searchParams.has('payment_status')) out = out.filter((o) => o.payment_status === 'unpaid')
      out = out.map((o) => ({ ...o, order_items: (db.order_items ?? []).filter((l) => l.order_id === o.id) }))
    }
    if ((req.headers()['accept'] ?? '').includes('vnd.pgrst.object'))
      return r.fulfill(json(200, out[0] ?? null))
    return r.fulfill(json(200, out))
  })
  return { db, calls }
}

async function addRow(
  page: Page,
  path: string,
  button: string,
  fill: (d: ReturnType<Page['getByRole']>) => Promise<void>,
) {
  await page.goto(`/r/demo-cafe/settings/${path}`)
  await page.getByRole('button', { name: button }).click()
  const dialog = page.getByRole('dialog')
  await fill(dialog)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog).toHaveCount(0)
}

test('Grill / Desserts / Amole / Runner created at runtime run the full order -> station board -> payment flow', async ({
  page,
}) => {
  const { db, calls } = await setup(page)

  // 1. configuration through the generic settings pages (colour / icon stored on the row)
  await addRow(page, 'stations', 'Add station', async (d) => {
    await d.getByLabel('Name').fill('Grill')
    await d.getByLabel('Colour (optional)').fill('#ea580c')
    await d.getByLabel('Icon (optional)').selectOption('chef-hat')
  })
  await expect(page.getByRole('list', { name: 'All stations' })).toContainText('Grill')
  await addRow(page, 'categories', 'Add category', async (d) => {
    await d.getByLabel('Name').fill('Desserts')
    await d.getByLabel('Icon (optional)').selectOption('cake-slice')
  })
  await addRow(page, 'payment-methods', 'Add payment method', async (d) => {
    await d.getByLabel('Name').fill('Amole')
    await d.getByLabel('Colour (optional)').fill('#7c3aed')
    await d.getByText('Needs a reference').click()
  })
  await addRow(page, 'table-areas', 'Add table area', async (d) => {
    await d.getByLabel('Name').fill('Garden')
  })
  await addRow(page, 'tables', 'Add table', async (d) => {
    await d.getByLabel('Name').fill('G1')
    await d.getByLabel('Area').selectOption({ label: 'Garden' })
  })
  await expect(page.getByRole('list', { name: 'All tables' })).toContainText('Garden')
  const grill = db.stations?.[0] as Row
  expect(grill).toMatchObject({ name: 'Grill', color: '#ea580c', icon: 'chef-hat' })
  expect(db.payment_methods?.[0]).toMatchObject({
    name: 'Amole',
    requires_reference: true,
    affects_cash_drawer: false,
  })

  // 2. a menu item on those rows, through the menu screen
  await page.goto('/r/demo-cafe/menu')
  await page.getByRole('button', { name: 'New item' }).click()
  const item = page.getByRole('dialog', { name: 'New menu item' })
  await item.getByLabel('Name').fill('Tiramisu')
  await item.getByLabel('Price (ETB)').fill('120')
  await item.getByLabel('Category').selectOption({ label: 'Desserts' })
  await item.getByLabel('Prepared at station').selectOption({ label: 'Grill' })
  await item.getByRole('button', { name: 'Create item' }).click()
  await expect(item).toHaveCount(0)

  // 3. POS: the new category filters the menu; the order is an intent
  await page.goto('/r/demo-cafe/pos')
  await page.getByRole('button', { name: 'Desserts' }).click()
  await page
    .getByRole('list', { name: 'Menu' })
    .getByRole('button', { name: /Tiramisu/ })
    .click()
  await page.getByLabel('Table').selectOption({ label: 'G1' })
  await page.getByRole('button', { name: 'Send order' }).click()
  await expect(page.getByTestId('pos-last-order')).toContainText('ORD-0001')
  await expect(page.getByTestId('pos-last-order')).toContainText('138.00')
  const sent = calls.find((c) => c.fn === 'fn_submit_order')?.body ?? {}
  expect(JSON.stringify(sent)).not.toMatch(/price|total|Grill|Desserts/)

  // 4. the station board of the new station (generated nav entry, generic route by UUID)
  await page.goto(`/r/demo-cafe/stations/${grill.id}`)
  await expect(page.getByRole('heading', { level: 1, name: 'Grill' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Grill/ }).first()).toBeVisible()
  const ticket = page.getByTestId('kds-ticket')
  await expect(ticket).toContainText('Tiramisu')
  await ticket.getByRole('button', { name: 'Start' }).click()
  await ticket.getByRole('button', { name: 'Ready' }).click()
  await expect(ticket).toContainText('Ready')
  expect(
    calls
      .filter((c) => c.fn === 'fn_set_station_items_status')
      .every((c) => c.body.p_station_id === grill.id),
  ).toBe(true)

  // 5. cashier: the new method's own flag (requires_reference) drives the form
  await page.goto('/r/demo-cafe/cashier')
  await page
    .getByRole('list', { name: 'Unpaid orders' })
    .getByRole('button', { name: /ORD-0001/ })
    .click()
  await page.locator('label', { hasText: 'Amole' }).click()
  const confirm = page.getByRole('button', { name: /Confirm payment/ })
  await expect(confirm).toBeDisabled()
  await page.getByLabel('Reference').fill('AM-123456')
  await confirm.click()
  const receipt = page.getByRole('article', { name: 'Receipt RCT-0001' })
  await expect(receipt).toContainText('138.00')
  await expect(receipt).toContainText('Amole')
  const pay = calls.find((c) => c.fn === 'fn_confirm_payment')?.body ?? {}
  expect(pay.p_payment_method_id).toBe(db.payment_methods?.[0]?.id)
  expect(db.orders?.[0]?.payment_status).toBe('paid')
})
