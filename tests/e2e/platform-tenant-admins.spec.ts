import { expect, test, type Page, type Route } from '@playwright/test'

// Platform Admin Portal: Tenant Admins card + authenticator reset (tenant-admin-mfa-reset Edge Function) and the plan editor's
// feature switches, against mocked Supabase Auth / REST / Functions (page.route); no real backend. The reset needs a fresh
// TOTP: the mocked function answers step_up_required first, the step-up dialog verifies, and the SAME request is sent again.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const SID = '44444444-4444-4444-8444-444444444444'
const jwtFor = (aal: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal, session_id: SID, exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const ADMIN = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const PLAN = '33333333-3333-4333-8333-333333333333'

interface Calls {
  reset: Array<{ body: Record<string, unknown>; auth: string | undefined }>
  rpc: Array<{ fn: string; body: Record<string, unknown> }>
}

async function setup(
  page: Page,
  opts: { resetError?: { status: number; code: string } } = {},
): Promise<Calls> {
  const calls: Calls = { reset: [], rpc: [] }
  let reset = false
  const factors = [
    {
      id: 'f-1',
      friendly_name: 'Phone',
      factor_type: 'totp',
      status: 'verified',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ]
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'root@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors,
  }
  const session = (aal: string) => ({
    access_token: jwtFor(aal),
    refresh_token: 'r',
    expires_at: exp,
    expires_in: 3600,
    token_type: 'bearer',
    user,
  })
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session('aal2'))],
  )
  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const preflight = (r: Route) =>
    r.request().method() === 'OPTIONS' && (void r.fulfill({ status: 204, headers: CORS }), true)

  const tenant = () => ({
    id: RID,
    name: 'Demo Cafe',
    slug: 'demo-cafe',
    status: 'active',
    timezone: 'Africa/Addis_Ababa',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    subscription: null,
    usage: {},
    limits: {},
    over_quota: [],
    invitations: [],
    recent_invoices: [],
    tenant_admins: [
      {
        profile_id: ADMIN,
        first_name: 'Selam',
        middle_name: 'Bekele',
        last_name: 'Tadesse',
        email: 'selam@example.com',
        is_active: true,
        mfa_enrolled: !reset,
        trusted_devices: reset ? 0 : 2,
      },
      {
        profile_id: OTHER,
        first_name: 'Dawit',
        middle_name: null,
        last_name: 'Alemu',
        email: 'dawit@example.com',
        is_active: true,
        mfa_enrolled: false,
        trusted_devices: 0,
      },
    ],
  })
  const plan = {
    id: PLAN,
    name: 'Basic',
    description: null,
    price_etb_monthly: 500,
    max_staff: 5,
    max_menu_items: null,
    max_stations: 1,
    max_kiosks: null,
    max_storage_bytes: null,
    max_orders_per_month: null,
    features: { qr_ordering: true },
    is_active: true,
    sort_order: 1,
    subscriber_count: 1,
  }

  await page.route('**/auth/v1/user', (r) => preflight(r) || r.fulfill(json(200, user)))
  await page.route('**/auth/v1/token*', (r) => preflight(r) || r.fulfill(json(200, session('aal2'))))
  await page.route(/\/auth\/v1\/factors/, (r) => {
    if (preflight(r)) return
    const action = new URL(r.request().url()).pathname.split('/').filter(Boolean)[4]
    if (action === 'challenge')
      return r.fulfill(json(200, { id: 'challenge-1', type: 'totp', expires_at: exp }))
    if (action === 'verify') return r.fulfill(json(200, session('aal2')))
    return r.fulfill(json(404, {}))
  })
  await page.route('**/functions/v1/tenant-admin-mfa-reset', (r) => {
    if (preflight(r)) return
    const req = r.request()
    const body = req.postDataJSON() as Record<string, unknown>
    calls.reset.push({ body, auth: req.headers()['authorization'] })
    if (calls.reset.length === 1) return r.fulfill(json(403, { error: 'step_up_required' }))
    if (opts.resetError) return r.fulfill(json(opts.resetError.status, { error: opts.resetError.code }))
    reset = true
    return r.fulfill(
      json(200, { profile_id: ADMIN, factors_removed: 1, sessions_revoked: 3, devices_revoked: 2 }),
    )
  })
  await page.route('**/rest/v1/**', (r) => {
    if (preflight(r)) return
    const req = r.request()
    const url = new URL(req.url())
    if (!url.pathname.includes('/rpc/')) return r.fulfill(json(200, []))
    const fn = url.pathname.split('/').pop() ?? ''
    calls.rpc.push({ fn, body: (req.postDataJSON() as Record<string, unknown> | null) ?? {} })
    if (fn === 'fn_get_session_context')
      return r.fulfill(
        json(200, {
          permissions: [],
          station_ids: [],
          platform_role: 'platform_super_admin',
          platform_mfa: true,
        }),
      )
    if (fn === 'fn_platform_get_tenant') return r.fulfill(json(200, tenant()))
    if (fn === 'fn_platform_list_plans') return r.fulfill(json(200, [plan]))
    if (fn === 'fn_platform_update_plan' || fn === 'fn_platform_create_plan')
      return r.fulfill(json(200, plan))
    return r.fulfill(json(200, null))
  })
  return calls
}

test('a Super Admin resets a Tenant Admin authenticator with a reason and a fresh code', async ({ page }) => {
  const calls = await setup(page)
  await page.goto(`/platform/tenants/${RID}`)
  const card = page.getByRole('region', { name: 'Tenant Admins' })
  const selam = card.getByRole('listitem', { name: 'Selam Bekele Tadesse' })
  await expect(selam).toContainText('selam@example.com')
  await expect(selam).toContainText('enrolled')
  await expect(selam).toContainText('Trusted devices:2')
  await expect(card.getByRole('listitem', { name: 'Dawit Alemu' }).getByRole('button')).toHaveCount(0)

  await selam.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }).click()
  const dialog = page.getByRole('dialog', { name: 'Reset authenticator: Selam Bekele' })
  await expect(dialog).toContainText('signs them out everywhere')
  await dialog.getByLabel('Reason (recorded in the audit log)').fill('Lost phone, identity confirmed by call')
  await dialog.getByRole('button', { name: 'Reset authenticator' }).click()

  const stepUp = page.getByRole('dialog', { name: 'Verify it is you' })
  await stepUp.getByLabel('Authentication code').fill('123456')
  await stepUp.getByRole('button', { name: 'Verify' }).click()

  await expect(page.getByText(/Authenticator reset for Selam Bekele/)).toBeVisible()
  await expect(dialog).toBeHidden()
  // the tenant query was invalidated: the refreshed posture shows no authenticator and no reset action
  await expect(selam).toContainText('not enrolled')
  await expect(selam.getByRole('button', { name: /Reset authenticator/ })).toHaveCount(0)

  expect(calls.reset).toHaveLength(2)
  for (const c of calls.reset) {
    expect(c.body).toEqual({
      restaurant_id: RID,
      profile_id: ADMIN,
      reason: 'Lost phone, identity confirmed by call',
    })
    expect(c.auth).toMatch(/^Bearer /)
  }
})

test('a refused reset shows fixed copy and changes nothing', async ({ page }) => {
  await setup(page, { resetError: { status: 429, code: 'rate_limited' } })
  await page.goto(`/platform/tenants/${RID}`)
  await page.getByRole('button', { name: 'Reset authenticator for Selam Bekele Tadesse' }).click()
  const dialog = page.getByRole('dialog', { name: /Reset authenticator/ })
  await dialog.getByLabel('Reason (recorded in the audit log)').fill('Lost phone')
  await dialog.getByRole('button', { name: 'Reset authenticator' }).click()
  const stepUp = page.getByRole('dialog', { name: 'Verify it is you' })
  await stepUp.getByLabel('Authentication code').fill('123456')
  await stepUp.getByRole('button', { name: 'Verify' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Too many requests. Wait a moment and try again.')
  await expect(dialog).toBeVisible()
})

test('the plan editor writes explicit feature switches and keeps unknown keys', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/platform/plans')
  const card = page.getByRole('article', { name: 'Basic' })
  await expect(card.getByRole('list', { name: 'Basic features' })).toContainText(
    'Installment vouchers: not included',
  )
  await card.getByRole('button', { name: 'Edit Basic' }).click()
  const dialog = page.getByRole('dialog', { name: 'Edit plan Basic' })
  const inst = dialog.getByRole('switch', { name: 'Installment vouchers' })
  await expect(inst).not.toBeChecked()
  await inst.check()
  await dialog.getByRole('button', { name: 'Save plan' }).click()
  await expect(dialog).toBeHidden()
  const update = calls.rpc.find((c) => c.fn === 'fn_platform_update_plan')
  expect((update?.body.p_patch as { features?: unknown } | undefined)?.features).toEqual({
    qr_ordering: true,
    installments: true,
    multi_station: false,
  })
})

test('a new plan starts with installment vouchers switched on', async ({ page }) => {
  await setup(page)
  await page.goto('/platform/plans')
  await page.getByRole('button', { name: 'New plan' }).click()
  const dialog = page.getByRole('dialog', { name: 'New plan' })
  await expect(dialog.getByRole('switch', { name: 'Installment vouchers' })).toBeChecked()
  await expect(dialog.getByRole('switch', { name: 'Multiple stations' })).not.toBeChecked()
})
