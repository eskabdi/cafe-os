import { expect, test, type Page } from '@playwright/test'

// Inactivity sign-out with mocked Supabase endpoints. The shortened timings use a window-level hook that exists only in
// DEV builds (import.meta.env.DEV); the production bundle ignores it.
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

const context = {
  user: { id: 'u-1', first_name: 'Abebe', username: 'abebe' },
  restaurant: { id: 'r-1', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
  role: { id: 'role-1', name: 'Some Role', system_key: null, is_active: true },
  permissions: [],
  station_ids: [],
}

async function signedInPage(page: Page) {
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 1500, warnMs: 1500 }
    },
    [JSON.stringify(session)],
  )
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': '*',
  }
  let loggedOut = false
  await page.route('**/auth/v1/logout*', (r) => {
    loggedOut = true
    return r.fulfill({ status: 204, headers: cors })
  })
  await page.route('**/auth/v1/user', (r) =>
    r.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(user),
    }),
  )
  await page.route('**/rest/v1/rpc/*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors })
    const fn = new URL(r.request().url()).pathname.split('/').pop()
    const body =
      fn === 'fn_get_session_context'
        ? context
        : fn === 'fn_resolve_tenant_slug'
          ? { name: 'Demo Cafe', branding: {} }
          : null
    return r.fulfill({
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  })
  return () => loggedOut
}

test('warns, lets Continue reset, then signs out and returns to the staff login', async ({ page }) => {
  const wasLoggedOut = await signedInPage(page)
  await page.goto('/r/demo-cafe')
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')

  const dialog = page.getByRole('alertdialog', { name: 'Still there?' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(dialog).toBeHidden()

  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(page).toHaveURL(/\/r\/demo-cafe\/login$/, { timeout: 5000 })
  await expect(dialog).toBeHidden()
  expect(wasLoggedOut()).toBe(true)
})
