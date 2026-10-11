import { expect, test, type Page } from '@playwright/test'

// Installments (Phase 7) against mocked Supabase. Payment method names are runtime data only; the client sends intents
// (voucher id, method id, reference, the installment number it saw, key) and never an amount or a schedule.
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
const VOUCHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const M_AMOLE = '11111111-1111-4111-8111-111111111111'
const M_CASH = '22222222-2222-4222-8222-222222222222'
const PAY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

async function setup(page: Page) {
  const calls: Record<string, Array<Record<string, unknown>>> = { collect: [], generate: [] }
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
    user: { id: 'u-1', first_name: 'Hana', short_name: 'Hana Girma', username: 'hana' },
    restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: ['vouchers.view', 'vouchers.manage', 'payments.create', 'orders.view', 'orders.view_all'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    open_day: { id: DAY, day_no: 12, opened_at: '2026-10-10T05:00:00Z' },
  }
  const methods = [
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
      color: '#7c3aed',
      icon: null,
      sort_order: 2,
      is_active: true,
      affects_cash_drawer: false,
      requires_reference: true,
    },
  ]
  const voucher = {
    id: VOUCHER,
    voucher_no: 'VCH-0003',
    order_id: ORDER,
    order_no: 'ORD-0042',
    customer_name: 'Abebe Kebede Alemu',
    customer_phone: '+251 911 000000',
    total: 1000,
    down_payment: 100,
    installment_count: 4,
    interval_days: 7,
    created_at: '2026-10-10T06:00:00Z',
    paid_installments: 1,
    paid_amount: 325,
    outstanding: 675,
    status: 'overdue',
    next_due: { no: 2, due_date: '2026-10-08', amount: 225 },
    installments: [
      {
        no: 1,
        due_date: '2026-10-01',
        amount: 225,
        paid: true,
        paid_at: '2026-10-01T08:00:00Z',
        payment_id: PAY,
      },
      { no: 2, due_date: '2026-10-08', amount: 225, paid: false, paid_at: null, payment_id: null },
      { no: 3, due_date: '2026-10-15', amount: 225, paid: false, paid_at: null, payment_id: null },
      { no: 4, due_date: '2026-10-22', amount: 225, paid: false, paid_at: null, payment_id: null },
    ],
  }
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
      if (name === 'fn_list_vouchers') {
        return r.fulfill(json(200, [{ ...voucher, installments: undefined }]))
      }
      if (name === 'fn_get_voucher') return r.fulfill(json(200, voucher))
      if (name === 'fn_confirm_installment') {
        calls.collect?.push(req.postDataJSON() as Record<string, unknown>)
        return r.fulfill(
          json(200, {
            payment_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            receipt_no: 'RCT-0011',
            kind: 'installment_payment',
            amount: 225,
            created_at: '2026-10-10T16:05:00Z',
            method: 'Amole',
            affects_cash_drawer: false,
            reference: 'AM-1',
            reversed_payment_id: null,
            reversed: false,
            received_by: 'Hana Girma',
            restaurant: {
              name: 'Demo Cafe',
              phone: null,
              address: null,
              tin: null,
              timezone: 'Africa/Addis_Ababa',
            },
            order: null,
            voucher: {
              voucher_no: 'VCH-0003',
              customer_name: 'Abebe Kebede Alemu',
              installment_no: 2,
              installment_count: 4,
              total: 1000,
              outstanding: 450,
            },
            voucher_status: 'active',
            replayed: false,
          }),
        )
      }
      if (name === 'fn_generate_voucher') {
        calls.generate?.push(req.postDataJSON() as Record<string, unknown>)
        return r.fulfill(json(200, { voucher, down_receipt: null, replayed: false }))
      }
      return r.fulfill(json(200, null))
    }
    if (name === 'payment_methods') return r.fulfill(json(200, methods))
    if (name === 'restaurants') return r.fulfill(json(200, { timezone: 'Africa/Addis_Ababa' }))
    if (name === 'orders')
      return r.fulfill(
        json(200, [
          {
            id: ORDER,
            order_no: 'ORD-0050',
            status: 'served',
            order_type: 'dine-in',
            table_label_snapshot: 'T2',
            created_by_name_snapshot: 'Yonas',
            total: '173.65',
            created_at: '2026-10-10T06:00:00Z',
          },
        ]),
      )
    return r.fulfill(json(200, []))
  })
  return calls
}

test('lists vouchers with computed status and collects the next installment with a method created as data', async ({
  page,
}) => {
  const calls = await setup(page)
  await page.goto('/r/demo-cafe/installments')
  await expect(page.getByRole('heading', { level: 1, name: 'Installments' })).toBeVisible()
  const card = page.getByRole('list', { name: 'Vouchers' }).getByRole('button', { name: /VCH-0003/ })
  await expect(card).toContainText('overdue')
  await expect(card).toContainText('1/4 paid')
  await card.click()
  const dialog = page.getByRole('dialog', { name: /Voucher VCH-0003/ })
  await expect(dialog.getByRole('table', { name: 'Schedule' })).toContainText('225.00')
  await dialog.locator('label', { hasText: 'Amole' }).click()
  const collect = dialog.getByRole('button', { name: 'Collect' })
  await expect(collect).toBeDisabled()
  await dialog.getByLabel('Reference').fill('AM-1')
  await collect.click()
  const receipt = page.getByRole('article', { name: 'Receipt RCT-0011' })
  await expect(receipt).toContainText('VCH-0003')
  await expect(receipt).toContainText('2 / 4')
  await expect(receipt).toContainText('450.00')
  expect(calls.collect).toHaveLength(1)
  const body = calls.collect?.[0] ?? {}
  expect(Object.keys(body).sort()).toEqual([
    'p_idempotency_key',
    'p_installment_no',
    'p_payment_method_id',
    'p_reference',
    'p_tendered',
    'p_voucher_id',
  ])
  expect(body.p_installment_no).toBe(2)
  expect(body.p_payment_method_id).toBe(M_AMOLE)
})

test('a new voucher previews the schedule and sends only the intent', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/r/demo-cafe/installments')
  await page.getByRole('button', { name: 'New voucher' }).click()
  const dialog = page.getByRole('dialog', { name: 'New installment voucher' })
  await dialog.getByLabel('Order').selectOption(ORDER)
  await dialog.getByLabel('Customer name').fill('Sara Tadesse Bekele')
  await dialog.getByLabel('Installments').fill('3')
  await dialog.getByLabel('Down payment (ETB)').fill('10')
  await dialog.locator('label', { hasText: 'Cash Drawer' }).click()
  await expect(dialog.getByRole('table', { name: 'Schedule preview' })).toContainText('53.65')
  await dialog.getByRole('button', { name: 'Issue voucher' }).click()
  await expect(page.getByRole('dialog', { name: /Voucher VCH-0003/ })).toBeVisible()
  const body = calls.generate?.[0] ?? {}
  expect(body.p_order_id).toBe(ORDER)
  expect(body.p_down_payment).toBe(10)
  expect(body.p_down_method_id).toBe(M_CASH)
  expect(body.p_installment_count).toBe(3)
  expect(body.p_interval_days).toBe(30)
  expect(JSON.stringify(body)).not.toMatch(/amount|schedule|total/)
})
