import { expect, test, type Page } from '@playwright/test'

// The tenant's session_timers (fn_get_session_context, migration 0025) drive the inactivity sign-out. No DEV override is set
// here (window.__CAFEOS_INACTIVITY__ would win), so the timings come from the mocked session context only.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', exp })}.sig`
const user = {
  id: 'u-1',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'x@staff.cafeos.invalid',
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
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}

async function signedIn(page: Page, timers: Record<string, number>) {
  await page.addInitScript(
    ([s]) => localStorage.setItem('sb-127-auth-token', s as string),
    [JSON.stringify(session)],
  )
  const context = {
    user: { id: 'u-1', first_name: 'Abebe', username: 'abebe' },
    restaurant: { id: 'r-1', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: 'role-1', name: 'Some Role', system_key: null, is_active: true },
    permissions: [],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: 4,
    session_timers: timers,
  }
  const json = (body: unknown) => ({
    status: 200,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let loggedOut = false
  await page.route('**/auth/v1/logout*', (r) => {
    loggedOut = true
    return r.fulfill({ status: 204, headers: CORS })
  })
  await page.route('**/auth/v1/user', (r) => r.fulfill(json(user)))
  await page.route('**/rest/v1/user_notifications*', (r) =>
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json([])),
  )
  await page.route('**/rest/v1/rpc/*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const fn = new URL(r.request().url()).pathname.split('/').pop()
    if (fn === 'fn_get_session_context') return r.fulfill(json(context))
    if (fn === 'fn_resolve_tenant_slug') return r.fulfill(json({ name: 'Demo Cafe', branding: {} }))
    return r.fulfill(json(null))
  })
  return () => loggedOut
}

test('a custom short timer (warn 5 s, sign-out 15 s, the minimum) signs out early', async ({ page }) => {
  const wasLoggedOut = await signedIn(page, {
    idle_warning_seconds: 5,
    signout_seconds: 15,
    pin_pad_idle_seconds: 60,
  })
  await page.goto('/r/demo-cafe')
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')
  const start = Date.now()

  const dialog = page.getByRole('alertdialog', { name: 'Still there?' })
  await expect(dialog).toBeVisible({ timeout: 8_000 })
  const shownAfter = Date.now() - start
  expect(shownAfter).toBeGreaterThan(3_500) // not before ~5 s
  expect(shownAfter).toBeLessThan(12_000) // the 15 s default would not have shown it yet
  // the warning is visible for signout - warn = 10 seconds
  await expect(
    page.getByRole('status').filter({ hasText: /Signing out in (10|[1-9]) seconds/ }),
  ).toBeVisible()

  await expect(page).toHaveURL(/\/r\/demo-cafe\/login$/, { timeout: 13_000 })
  expect(Date.now() - start).toBeLessThan(25_000) // well before the 30 s default
  expect(wasLoggedOut()).toBe(true)
})

test('a custom longer timer (warn 20 s) keeps the default 15 s warning from appearing', async ({ page }) => {
  await signedIn(page, { idle_warning_seconds: 20, signout_seconds: 40, pin_pad_idle_seconds: 60 })
  await page.goto('/r/demo-cafe')
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')
  const dialog = page.getByRole('alertdialog', { name: 'Still there?' })
  await page.waitForTimeout(17_000) // past the 15 s default
  await expect(dialog).toBeHidden()
  await expect(dialog).toBeVisible({ timeout: 6_000 })
  await expect(
    page.getByRole('status').filter({ hasText: /Signing out in (1[5-9]|20) seconds/ }),
  ).toBeVisible()
})
