import { expect, test, type Page, type WebSocketRoute } from '@playwright/test'

// Forced PIN change -> waiting for approval -> approved, against mocked Supabase endpoints (page.route) and a mocked
// Realtime socket (page.routeWebSocket speaking the realtime-js v2 JSON protocol). No real backend is involved.
const UID = '11111111-1111-4111-8111-111111111111'
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const exp = Math.floor(Date.now() / 1000) + 3600
const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, aud: 'authenticated', role: 'authenticated', exp })}.sig`
const user = {
  id: UID,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'abebe@staff.cafeos.invalid',
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

type Status = 'none' | 'required' | 'pending_approval'
const context = (status: Status) => ({
  user: { id: UID, first_name: 'Abebe', short_name: 'Abebe Kebede', username: 'abebe' },
  restaurant: { id: 'r-1', name: 'Demo Cafe', slug: 'demo-cafe', status: 'active' },
  role: { id: 'role-1', name: 'Runner', system_key: null, is_active: true },
  permissions: status === 'none' ? ['orders.view'] : [],
  station_ids: [],
  must_change_pin: status === 'required',
  pin_change_status: status,
  pin_length: 4,
})

interface Mock {
  status: Status
  pinChangeBodies: unknown[]
  pinChangeAuth: string[]
  markedRead: string[]
  socket: { ws: WebSocketRoute; topic: string; joinRef: string } | null
}

async function setup(page: Page): Promise<Mock> {
  const m: Mock = { status: 'required', pinChangeBodies: [], pinChangeAuth: [], markedRead: [], socket: null }
  await page.addInitScript(
    ([s]) => {
      localStorage.setItem('sb-127-auth-token', s as string)
      window.__CAFEOS_INACTIVITY__ = { idleMs: 600_000, warnMs: 600_000 }
    },
    [JSON.stringify(session)],
  )
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { ...CORS, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  await page.route('**/auth/v1/user', (r) => r.fulfill(json(200, user)))
  await page.route('**/auth/v1/logout*', (r) => r.fulfill({ status: 204, headers: CORS }))
  await page.route('**/rest/v1/user_notifications*', (r) =>
    r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(json(200, [])),
  )
  await page.route('**/rest/v1/rpc/*', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    const fn = new URL(r.request().url()).pathname.split('/').pop()
    if (fn === 'fn_get_session_context') return r.fulfill(json(200, context(m.status)))
    if (fn === 'fn_mark_notification_read') {
      const id = (r.request().postDataJSON() as { p_id: string }).p_id
      m.markedRead.push(id)
      return r.fulfill(json(200, { id, read_at: new Date().toISOString() }))
    }
    return r.fulfill(json(200, null))
  })
  let attempt = 0
  await page.route('**/functions/v1/pin-change', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS })
    attempt += 1
    m.pinChangeBodies.push(r.request().postDataJSON())
    m.pinChangeAuth.push(r.request().headers()['authorization'] ?? '')
    if (attempt === 1) return r.fulfill(json(401, { error: 'invalid_credentials' }))
    m.status = 'pending_approval'
    return r.fulfill(json(200, { changed: true, pending_approval: true, other_sessions_revoked: true }))
  })
  // Realtime: answer every push with ok; the notifications channel join gets its postgres_changes binding id.
  await page.routeWebSocket(/\/realtime\/v1\/websocket/, (ws) => {
    ws.onMessage((raw) => {
      const [joinRef, ref, topic, event, payload] = JSON.parse(String(raw)) as [
        string | null,
        string | null,
        string,
        string,
        { config?: { postgres_changes?: Array<Record<string, string>> } },
      ]
      if (!ref) return
      let response: Record<string, unknown> = {}
      if (event === 'phx_join') {
        const changes = (payload.config?.postgres_changes ?? []).map((c, i) => ({ ...c, id: 1000 + i }))
        response = { postgres_changes: changes }
        if (topic.startsWith('realtime:user-notifications:'))
          m.socket = { ws, topic, joinRef: joinRef ?? ref }
      }
      ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]))
    })
  })
  return m
}

function pushNotification(m: Mock, id: string, kind: string) {
  if (!m.socket) throw new Error('notifications channel not joined')
  const record = {
    id,
    restaurant_id: '99999999-9999-4999-8999-999999999999',
    recipient_id: UID,
    kind,
    payload: { profile_id: UID, user_name: 'Abebe Kebede', at: new Date().toISOString() },
    created_at: new Date().toISOString(),
    read_at: null,
  }
  const columns = [
    { name: 'id', type: 'uuid' },
    { name: 'restaurant_id', type: 'uuid' },
    { name: 'recipient_id', type: 'uuid' },
    { name: 'kind', type: 'text' },
    { name: 'payload', type: 'jsonb' },
    { name: 'created_at', type: 'timestamptz' },
    { name: 'read_at', type: 'timestamptz' },
  ]
  m.socket.ws.send(
    JSON.stringify([
      m.socket.joinRef,
      null,
      m.socket.topic,
      'postgres_changes',
      {
        ids: [1000],
        data: {
          type: 'INSERT',
          schema: 'public',
          table: 'user_notifications',
          commit_timestamp: record.created_at,
          columns,
          record,
          errors: null,
        },
      },
    ]),
  )
}

async function enterPin(page: Page, pin: string, submit: string) {
  for (const d of pin) await page.getByRole('button', { name: `Digit ${d}`, exact: true }).click()
  await page.getByRole('button', { name: submit, exact: true }).click()
}

test('forced change -> waiting for approval -> approved live over Realtime', async ({ page }) => {
  const m = await setup(page)
  await page.goto('/r/demo-cafe/orders')

  // every tenant route lands on Change PIN; the header keeps a Change PIN button
  await expect(page).toHaveURL(/\/r\/demo-cafe\/change-pin$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Change your PIN' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Change PIN' })).toBeVisible()
  await expect(page.getByText('0 of 4 digits entered')).toBeAttached()

  // a wrong current PIN: neutral message, back to step 1, nothing echoed
  await enterPin(page, '4829', 'Next')
  await enterPin(page, '7391', 'Next')
  await enterPin(page, '7391', 'Change PIN')
  await expect(page.getByRole('alert')).toHaveText(
    'Your current PIN was not accepted. Check it and try again. If it keeps happening, ask your manager.',
  )
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Enter your current PIN')
  await expect(page.locator('body')).not.toContainText('4829')

  await enterPin(page, '5820', 'Next')
  await enterPin(page, '7391', 'Next')
  await enterPin(page, '7391', 'Change PIN')
  await expect(page.getByRole('heading', { name: 'Your PIN has been changed' })).toBeVisible()
  expect(m.pinChangeBodies).toEqual([
    { current_pin: '4829', new_pin: '7391' },
    { current_pin: '5820', new_pin: '7391' },
  ])
  expect(m.pinChangeAuth.every((a) => a === `Bearer ${jwt}`)).toBe(true)

  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page).toHaveURL(/\/r\/demo-cafe\/pin-pending$/)
  await expect(page.getByRole('heading', { name: 'Waiting for manager approval' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Change PIN' })).toHaveCount(0)

  // a manager approves: the server state flips and the notification arrives over Realtime
  await expect.poll(() => m.socket !== null).toBe(true)
  m.status = 'none'
  const noteId = '44444444-4444-4444-8444-444444444444'
  pushNotification(m, noteId, 'security.pin_change_approved')

  await expect(page).toHaveURL(/\/r\/demo-cafe$/)
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')
  const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Your new PIN was approved' })
  await expect(toast).toBeVisible()
  await toast.getByRole('button', { name: 'Close toast' }).click()
  await expect.poll(() => m.markedRead).toEqual([noteId])
})

test('429 from pin-change locks the pad for Retry-After seconds', async ({ page }) => {
  await setup(page)
  await page.route('**/functions/v1/pin-change', (r) =>
    r.request().method() === 'OPTIONS'
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill({
          status: 429,
          headers: {
            ...CORS,
            'content-type': 'application/json',
            'Retry-After': '2',
            'access-control-expose-headers': 'Retry-After',
          },
          body: JSON.stringify({ error: 'try_later' }),
        }),
  )
  await page.goto('/r/demo-cafe')
  await expect(page).toHaveURL(/\/change-pin$/)
  await enterPin(page, '4829', 'Next')
  await enterPin(page, '7391', 'Next')
  await enterPin(page, '7391', 'Change PIN')
  await expect(page.getByRole('alert')).toHaveText('Too many attempts. Try again in 2 seconds.')
  await expect(page.getByRole('button', { name: 'Digit 1', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Digit 1', exact: true })).toBeEnabled({ timeout: 5000 })
})
