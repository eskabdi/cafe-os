import { expect, test, type Page } from '@playwright/test'

// Phase 2 tenant shell against mocked Supabase Auth / REST / RPC (page.route); no real backend. The station names below
// are runtime data only: no source code knows them (generic StationKDS by UUID).
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const RID = '99999999-9999-4999-8999-999999999999'
const S_GRILL = '11111111-1111-4111-8111-111111111111'
const S_OTHER = '22222222-2222-4222-8222-222222222222'
const S_HIDDEN = '33333333-3333-4333-8333-333333333333'

async function setup(page: Page) {
  const user = {
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'x.staff.cafeos.invalid',
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
    user: { id: 'u-1', first_name: 'Abebe', short_name: 'Abebe Kebede', username: 'abebe' },
    restaurant: {
      id: RID,
      name: 'Demo Cafe',
      slug: 'demo-cafe',
      status: 'active',
      branding: { primary_color: '#1d4ed8', accent_color: '#1e3a8a', logo_path: null },
    },
    role: { id: '88888888-8888-4888-8888-888888888888', name: 'Runner', system_key: null, is_active: true },
    permissions: ['orders.view', 'orders.create'],
    station_ids: [S_GRILL, S_OTHER],
    pin_change_status: 'none',
    pin_length: 4,
  }
  const stations = [
    {
      id: S_GRILL,
      name: 'Grill',
      description: null,
      color: '#ea580c',
      icon: 'soup',
      sort_order: 1,
      is_active: true,
    },
    {
      id: S_OTHER,
      name: 'Cold Line',
      description: null,
      color: null,
      icon: null,
      sort_order: 2,
      is_active: true,
    },
    {
      id: S_HIDDEN,
      name: 'Not Mine',
      description: null,
      color: '#7c3aed',
      icon: null,
      sort_order: 3,
      is_active: true,
    },
  ]
  await page.route('**/auth/v1/**', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill(json(200, user)),
  )
  await page.route('**/rest/v1/user_notifications*', (r) =>
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, [])),
  )
  await page.route('**/rest/v1/stations*', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill(json(200, stations)),
  )
  await page.route('**/rest/v1/rpc/*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const fn = new URL(r.request().url()).pathname.split('/').pop()
    if (fn === 'fn_get_session_context') return r.fulfill(json(200, context))
    return r.fulfill(json(200, null))
  })
}

test('desktop: permission nav, station nav from rows, generic station board, tenant theme', async ({
  page,
}) => {
  await setup(page)
  await page.goto('/r/demo-cafe')
  const nav = page.getByRole('complementary', { name: 'Sidebar' }).getByRole('navigation', { name: 'Main' })
  await expect(nav.getByRole('link', { name: 'POS' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Cashier' })).toHaveCount(0)
  await expect(nav.getByRole('link', { name: 'Grill' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Cold Line' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Not Mine' })).toHaveCount(0)

  const primary = await page.evaluate(() => document.documentElement.style.getPropertyValue('--primary'))
  expect(primary).toBe('224 76% 48%')

  await nav.getByRole('link', { name: 'Grill' }).click()
  await expect(page).toHaveURL(new RegExp(`/r/demo-cafe/stations/${S_GRILL}$`))
  await expect(page.getByRole('heading', { level: 1, name: 'Grill' })).toBeVisible()
})

test('a module or station without access renders 403', async ({ page }) => {
  await setup(page)
  await page.goto('/r/demo-cafe/cashier')
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible()
  await page.goto(`/r/demo-cafe/stations/${S_HIDDEN}`)
  await expect(page.getByRole('heading', { name: 'Not authorised' })).toBeVisible()
})

test('mobile: drawer navigation reaches a module and closes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setup(page)
  await page.goto('/r/demo-cafe')
  await expect(page.getByRole('complementary', { name: 'Sidebar' })).toBeHidden()
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await drawer.getByRole('link', { name: 'POS' }).click()
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/r\/demo-cafe\/pos$/)
})
