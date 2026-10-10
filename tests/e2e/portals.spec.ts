import { expect, test, type Page } from '@playwright/test'

// Two portals (§34A), against mocked Supabase Auth / REST / RPC (page.route); no real backend. A Super Admin never renders a
// tenant screen and a tenant identity never renders the Platform Admin Portal. A trusted device skips the TOTP code.
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const SID = '44444444-4444-4444-8444-444444444444'
const jwt = (aal: string) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'u-1', aud: 'authenticated', role: 'authenticated', aal, session_id: SID, exp })}.sig`
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }
const RID = '99999999-9999-4999-8999-999999999999'
const TOKEN = 'b'.repeat(64)

const health = {
  checked_at: '2026-10-09T10:00:00Z',
  database: { reachable: true, server_version: '15.8', size_bytes: 1000, started_at: '2026-10-01T00:00:00Z', connections: 3, max_connections: 100 },
  migrations: { latest: '20261003003200', count: 33, source: 'supabase_migrations' },
  largest_tables: [],
  storage: [],
  tenants: { total: 2, by_status: { active: 2 } },
  counters: {
    tenant_audit_events_24h: 0,
    platform_audit_events_24h: 0,
    pin_lockouts_active: 0,
    pin_changes_pending_approval: 0,
    invitations_pending: 0,
    invitations_expired: 0,
    backup_failures_7d: 0,
  },
  backups: { last_success_at: null, last_success_age_hours: null, stale: true, last_run: null },
}

interface Calls {
  rpc: string[]
}

async function setup(page: Page, kind: 'platform' | 'tenant', opts: { mfa?: boolean; storedToken?: boolean } = {}): Promise<Calls> {
  const calls: Calls = { rpc: [] }
  let platformMfa = opts.mfa ?? true
  const user = { id: 'u-1', aud: 'authenticated', role: 'authenticated', email: 'admin@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z',
    factors: [{ id: 'f-1', friendly_name: 'Phone', factor_type: 'totp', status: 'verified', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }] }
  const session = { access_token: jwt('aal1'), refresh_token: 'r', expires_at: exp, expires_in: 3600, token_type: 'bearer', user }
  await page.addInitScript(
    ([s, token]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      if (token) localStorage.setItem('cafeos.trusted-device.v1.u-1', token as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session), opts.storedToken ? TOKEN : ''],
  )
  const json = (status: number, body: unknown) => ({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const context = () =>
    kind === 'platform'
      ? { permissions: [], station_ids: [], platform_role: 'platform_super_admin', platform_mfa: platformMfa }
      : {
          user: { id: 'u-1', first_name: 'Selam', short_name: 'Selam', username: 'selam' },
          restaurant: { id: RID, name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
          role: { id: '88888888-8888-4888-8888-888888888888', name: 'Owner', system_key: 'tenant_admin', is_active: true },
          permissions: ['dashboard.view', 'orders.create', 'settings.manage', 'users.view', 'users.manage', 'roles.manage'],
          station_ids: [],
          pin_change_status: 'none',
          pin_length: null,
        }
  await page.route('**/auth/v1/factors*', (r) =>
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, { all: [], totp: [{ id: 'f-1', status: 'verified' }] })),
  )
  await page.route('**/auth/v1/user', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, user))))
  await page.route('**/rest/v1/**', (r) => {
    const req = r.request()
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const url = new URL(req.url())
    if (!url.pathname.includes('/rpc/')) return r.fulfill(json(200, []))
    const fn = url.pathname.split('/').pop() ?? ''
    calls.rpc.push(fn)
    if (fn === 'fn_get_session_context') return r.fulfill(json(200, context()))
    if (fn === 'fn_check_trusted_device') {
      platformMfa = true
      return r.fulfill(json(200, { trusted: true, expires_at: '2026-11-08T00:00:00Z' }))
    }
    if (fn === 'fn_platform_system_health') return r.fulfill(json(200, health))
    if (fn === 'fn_platform_list_tenants') return r.fulfill(json(200, { items: [], total: 0 }))
    return r.fulfill(json(200, null))
  })
  return calls
}

test('a Super Admin opening a tenant address is sent to the Platform Admin Portal', async ({ page }) => {
  await setup(page, 'platform')
  await page.goto('/r/demo-cafe/pos')
  await expect(page).toHaveURL(/\/platform$/)
  const nav = page.getByRole('navigation', { name: 'Platform' }).first()
  await expect(nav.getByRole('link', { name: 'Tenants' })).toBeVisible()
  for (const tenantOnly of ['POS', 'Cashier', 'Dashboard', 'Menu', 'Inventory']) {
    await expect(page.getByRole('link', { name: tenantOnly, exact: true })).toHaveCount(0)
  }
  await expect(page.getByTestId('platform-actor')).toHaveText('Super Admin')
})

test('a Tenant Admin opening the platform address is sent to their own Tenant Portal', async ({ page }) => {
  await setup(page, 'tenant')
  await page.goto('/platform/tenants')
  await expect(page).toHaveURL(/\/r\/demo-cafe$/)
  await expect(page.getByRole('link', { name: 'Tenants', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Users', exact: true }).first()).toBeVisible()
})

test('a trusted device opens the Platform Admin Portal without a code', async ({ page }) => {
  const calls = await setup(page, 'platform', { mfa: false, storedToken: true })
  await page.goto('/platform')
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
  expect(calls.rpc).toContain('fn_check_trusted_device')
  await expect(page.getByLabel('Authentication code')).toHaveCount(0)
})

test('a new device is asked for the code and can be trusted for 30 days', async ({ page }) => {
  await setup(page, 'platform', { mfa: false })
  await page.goto('/platform')
  await expect(page.getByLabel('Authentication code')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Trust this device for 30 days' })).toBeChecked()
})
