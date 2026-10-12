import { expect, test, type Page, type Route } from '@playwright/test'

// /reset-password: landing page of the recovery e-mail sent after a Super Admin authenticator reset (tenant-admin-mfa-reset,
// RECOVERY_REDIRECT_URL, implicit flow). Mocked Supabase Auth / REST / Functions (page.route); no real backend.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const UID = '11111111-1111-4111-8111-111111111111'
const RID = '99999999-9999-4999-8999-999999999999'
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, aud: 'authenticated', role: 'authenticated', aal: 'aal1', exp })}.sig`
const LINK = `/reset-password#access_token=${JWT}&expires_at=${exp}&expires_in=3600&refresh_token=recovery-refresh-1&token_type=bearer&type=recovery`
const NEW_PASSWORD = 'Fresh start 2026 cafe'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}

interface Calls {
  updates: Array<Record<string, unknown>>
  logouts: string[]
}

async function setup(page: Page): Promise<Calls> {
  const calls: Calls = { updates: [], logouts: [] }
  const user = {
    id: UID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'selam@example.com',
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const preflight = (r: Route) =>
    r.request().method() === 'OPTIONS' && (void r.fulfill({ status: 204, headers: CORS }), true)

  await page.route('**/auth/v1/user', (r) => {
    if (preflight(r)) return
    if (r.request().method() === 'PUT') calls.updates.push(r.request().postDataJSON() as Record<string, unknown>)
    return r.fulfill(json(200, user))
  })
  await page.route('**/auth/v1/logout*', (r) => {
    if (preflight(r)) return
    calls.logouts.push(new URL(r.request().url()).searchParams.get('scope') ?? '')
    return r.fulfill({ status: 204, headers: CORS })
  })
  await page.route('**/auth/v1/token*', (r) => preflight(r) || r.fulfill(json(400, { error: 'invalid_grant' })))
  await page.route('**/functions/v1/**', (r) => preflight(r) || r.fulfill(json(404, { error: 'not_found' })))
  await page.route('**/rest/v1/**', (r) => {
    if (preflight(r)) return
    const fn = new URL(r.request().url()).pathname.split('/').pop() ?? ''
    if (fn === 'fn_get_session_context')
      return r.fulfill(
        json(200, {
          user: { id: UID, first_name: 'Selam', middle_name: 'Bekele', username: 'selam' },
          restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
          role: { id: 'role-1', name: 'Tenant Admin', system_key: 'tenant_admin', is_active: true },
          permissions: [],
          station_ids: [],
        }),
      )
    if (fn === 'fn_resolve_tenant_slug') return r.fulfill(json(200, { id: RID, name: 'Demo Cafe', slug: 'demo-cafe' }))
    return r.fulfill(json(200, null))
  })
  return calls
}

test('a Tenant Admin sets a new password from the recovery link and is sent to admin sign-in', async ({ page }) => {
  const calls = await setup(page)
  await page.goto(LINK)

  await expect(page.getByText('The platform administrator reset your authenticator')).toBeVisible()
  // the recovery tokens are removed from the address bar on arrival
  await expect.poll(() => new URL(page.url()).hash).toBe('')

  await page.getByLabel('New password', { exact: true }).fill('short1')
  await page.getByLabel('Repeat the new password').fill('short1')
  await page.getByRole('button', { name: 'Save new password' }).click()
  await expect(page.getByRole('alert')).toContainText('at least 12')
  expect(calls.updates).toHaveLength(0)

  await page.getByLabel('New password', { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel('Repeat the new password').fill(NEW_PASSWORD)
  await page.getByRole('button', { name: 'Save new password' }).click()

  await expect(page).toHaveURL(/\/r\/demo-cafe\/admin-login$/)
  await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toHaveText(
    'Password changed. Sign in, then set up your authenticator again.',
  )
  expect(calls.updates.map((u) => u.password)).toEqual([NEW_PASSWORD])
  expect(calls.logouts).toEqual(['global'])
  // signed out locally too; the password is never kept in browser storage
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))
  expect(storage).not.toContain(NEW_PASSWORD)
  expect(storage).not.toContain('auth-token')
})

test('an expired or used recovery link asks for a new reset by the platform administrator', async ({ page }) => {
  const calls = await setup(page)
  await page.goto('/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
  await expect(page.getByRole('alert')).toContainText(
    'This link has expired or has already been used. Ask the platform administrator to reset your authenticator again',
  )
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
  expect(calls.updates).toHaveLength(0)
})

test('a link that is not a recovery link is refused', async ({ page }) => {
  await setup(page)
  await page.goto(LINK.replace('type=recovery', 'type=magiclink'))
  await expect(page.getByRole('alert')).toContainText('This is not a valid password-reset link')
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0)
})
