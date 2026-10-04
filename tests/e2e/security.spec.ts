import { expect, test, type Page } from '@playwright/test'

// Self-service authenticator (TOTP) setup at /r/:slug/settings/security, against mocked Supabase Auth and RPC endpoints
// (page.route). No real backend is involved: the mock keeps a tiny factor store behind /auth/v1/user and /auth/v1/factors.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwtFor = (aal: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal, exp })}.sig`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
}
const SECRET = 'JBSWY3DPEHPK3PXP'
const QR =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#000"/></svg>'

interface Factor {
  id: string
  friendly_name: string
  factor_type: 'totp'
  status: 'verified' | 'unverified'
  created_at: string
  updated_at: string
}
interface Mock {
  factors: Factor[]
  enrollBodies: unknown[]
  verifyBodies: unknown[]
  removed: string[]
  refreshCalls: number
  contextCalls: number
}

async function setup(page: Page, email: string, appMetadata: Record<string, unknown> = {}): Promise<Mock> {
  const m: Mock = {
    factors: [],
    enrollBodies: [],
    verifyBodies: [],
    removed: [],
    refreshCalls: 0,
    contextCalls: 0,
  }
  const user = () => ({
    id: 'u-1',
    aud: 'authenticated',
    role: 'authenticated',
    email,
    app_metadata: appMetadata,
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    factors: m.factors,
  })
  const session = (aal: string) => ({
    access_token: jwtFor(aal),
    refresh_token: 'r',
    expires_at: exp,
    expires_in: 3600,
    token_type: 'bearer',
    user: user(),
  })
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session('aal1'))],
  )
  const json = (status: number, body: unknown) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const context = {
    user: { id: 'u-1', first_name: 'Owner', short_name: 'Owner', username: 'owner' },
    restaurant: { id: 'r-1', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
    role: { id: 'role-1', name: 'Owner', system_key: 'tenant_admin', is_active: true },
    permissions: ['users.manage', 'settings.session_timers'],
    station_ids: [],
    pin_change_status: 'none',
    pin_length: null,
  }

  await page.route('**/auth/v1/user', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill(json(200, user())),
  )
  await page.route('**/auth/v1/logout*', (r) => r.fulfill({ status: 204, headers: CORS }))
  await page.route('**/auth/v1/token*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    m.refreshCalls++
    return r.fulfill(json(200, session('aal2')))
  })
  await page.route(/\/auth\/v1\/factors/, (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const parts = new URL(req.url()).pathname.split('/').filter(Boolean) // auth v1 factors [id [challenge|verify]]
    const id = parts[3]
    const action = parts[4]
    if (req.method() === 'POST' && !id) {
      m.enrollBodies.push(req.postDataJSON())
      const f: Factor = {
        id: 'f-new',
        friendly_name: (req.postDataJSON() as { friendly_name: string }).friendly_name,
        factor_type: 'totp',
        status: 'unverified',
        created_at: '2026-03-04T10:00:00Z',
        updated_at: '2026-03-04T10:00:00Z',
      }
      m.factors.push(f)
      return r.fulfill(
        json(200, {
          id: f.id,
          type: 'totp',
          friendly_name: f.friendly_name,
          totp: { qr_code: QR, secret: SECRET, uri: `otpauth://totp/CafeOS?secret=${SECRET}` },
        }),
      )
    }
    if (req.method() === 'POST' && action === 'challenge') {
      return r.fulfill(json(200, { id: 'challenge-1', type: 'totp', expires_at: exp }))
    }
    if (req.method() === 'POST' && action === 'verify') {
      const body = req.postDataJSON() as { code: string }
      m.verifyBodies.push(body)
      if (body.code !== '123456') {
        return r.fulfill(
          json(400, { code: 'mfa_verification_failed', error_code: 'mfa_verification_failed', msg: 'x' }),
        )
      }
      for (const f of m.factors) if (f.id === id) f.status = 'verified'
      return r.fulfill(json(200, session('aal2')))
    }
    if (req.method() === 'DELETE' && id) {
      m.removed.push(id)
      m.factors = m.factors.filter((f) => f.id !== id)
      return r.fulfill(json(200, { id }))
    }
    return r.fulfill(json(404, { msg: 'not mocked' }))
  })
  await page.route('**/rest/v1/user_notifications*', (r) =>
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, [])),
  )
  await page.route('**/rest/v1/rpc/*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const fn = new URL(r.request().url()).pathname.split('/').pop()
    if (fn === 'fn_get_session_context') {
      m.contextCalls++
      return r.fulfill(json(200, context))
    }
    if (fn === 'fn_resolve_tenant_slug') return r.fulfill(json(200, { name: 'Demo Cafe', branding: {} }))
    return r.fulfill(json(200, null))
  })
  return m
}

test('an email sign-in sets up an authenticator, then removes it after a code', async ({ page }) => {
  const m = await setup(page, 'owner@example.com')
  await page.goto('/r/demo-cafe')
  await page.getByRole('link', { name: 'Security' }).click()
  await expect(page).toHaveURL(/\/r\/demo-cafe\/settings\/security$/)
  await expect(page.getByRole('heading', { name: 'Security' })).toBeVisible()

  await page.getByRole('button', { name: 'Set up authenticator' }).click()
  await expect.poll(() => m.enrollBodies.length).toBe(1)
  expect(m.enrollBodies[0]).toMatchObject({ factor_type: 'totp', friendly_name: 'Authenticator app' })
  const qr = page.getByRole('img', { name: /scan with your authenticator app/i })
  await expect(qr).toBeVisible()
  // the QR really decodes as an image (an <img> data URL, never injected markup)
  await expect.poll(() => qr.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await expect(page.getByTestId('authenticator-key')).toHaveText('JBSW Y3DP EHPK 3PXP')
  await expect(page.getByLabel('Authentication code')).toHaveAttribute('autocomplete', 'one-time-code')

  // wrong code: neutral message, nothing is enrolled yet
  const contextBefore = m.contextCalls
  await page.getByLabel('Authentication code').fill('000000')
  await page.getByRole('button', { name: 'Verify and finish' }).click()
  const alert = page.getByRole('alert')
  await expect(alert).toContainText('That code did not work.')
  await expect(alert).not.toContainText(/mfa|aal/i)
  expect(m.refreshCalls).toBe(0)

  // right code: session refreshed, context reloaded, secret gone, factor listed as active
  await page.getByLabel('Authentication code').fill('123456')
  await page.getByRole('button', { name: 'Verify and finish' }).click()
  const factorRow = page.getByRole('listitem').filter({ hasText: 'Authenticator app' })
  await expect(factorRow).toHaveCount(1)
  await expect(factorRow).toContainText('Active')
  await expect(page.getByTestId('authenticator-key')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(SECRET)
  expect(m.refreshCalls).toBeGreaterThan(0)
  await expect.poll(() => m.contextCalls).toBeGreaterThan(contextBefore)

  // removal: warning + code first
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText(
    'approving PIN changes and changing the session timers will stop working',
  )
  await dialog.getByLabel('Authentication code').fill('123456')
  await dialog.getByRole('button', { name: 'Remove authenticator' }).click()
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toBeVisible()
  expect(m.removed).toEqual(['f-new'])
  expect(m.verifyBodies.length).toBe(3)
})

test('a PIN session has no Security link and sees a notice at the URL', async ({ page }) => {
  const m = await setup(page, 'abebe@demo.staff.cafeos.invalid', { staff: true })
  await page.goto('/r/demo-cafe')
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')
  await expect(page.getByRole('link', { name: 'Security' })).toHaveCount(0)

  await page.goto('/r/demo-cafe/settings/security')
  await expect(page.getByRole('alert')).toContainText(
    'only available to accounts that sign in with an email address',
  )
  await expect(page.getByRole('button', { name: 'Set up authenticator' })).toHaveCount(0)
  expect(m.enrollBodies).toEqual([])
})
