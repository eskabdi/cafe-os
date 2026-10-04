import { expect, test, type Page, type Route } from '@playwright/test'

// Shared floor terminal (kiosk) UI against mocked Edge Functions: no Supabase needed beyond the smoke env.
const SLUG = 'demo-cafe'
const TOKEN = 'ab'.repeat(32)
const STORAGE_KEY = `cafeos:kiosk:${SLUG}`
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
}

const roster = {
  staff: [
    {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Abebe Kebede',
      role: 'Waiter',
      color: '#2563eb',
      icon: 'concierge-bell',
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Dawit Haile',
      role: 'Runner',
      color: '#fde047',
      icon: 'bike',
    },
  ],
}

async function mockFn(
  page: Page,
  name: string,
  handler: (route: Route, body: Record<string, unknown>) => Promise<void>,
) {
  await page.route(`**/functions/v1/${name}`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    await handler(route, route.request().postDataJSON() ?? {})
  })
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

async function withToken(page: Page) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k as string, v as string), [STORAGE_KEY, TOKEN])
}

test('a device without a token shows the neutral not-set-up screen', async ({ page }) => {
  let called = false
  await mockFn(page, 'staff-roster', async (route) => {
    called = true
    await json(route, 401, { error: 'invalid_kiosk' })
  })
  await page.goto(`/r/${SLUG}/terminal`)
  await expect(page.getByText('This terminal is not set up. Ask a manager to register it.')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in with username' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Admin sign-in' })).toBeVisible()
  expect(called).toBe(false)
})

test('a 401 roster clears the stored token and shows the same neutral screen', async ({ page }) => {
  await withToken(page)
  await mockFn(page, 'staff-roster', (route) => json(route, 401, { error: 'invalid_kiosk' }))
  await page.goto(`/r/${SLUG}/terminal`)
  await expect(page.getByText('This terminal is not set up. Ask a manager to register it.')).toBeVisible()
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBeNull()
})

test('tiles come from the roster, the pad has four dots, and a wrong PIN shows the generic message', async ({
  page,
}) => {
  await withToken(page)
  let rosterBody: Record<string, unknown> = {}
  let loginBody: Record<string, unknown> = {}
  await mockFn(page, 'staff-roster', async (route, body) => {
    rosterBody = body
    await json(route, 200, roster)
  })
  await mockFn(page, 'pin-login', async (route, body) => {
    loginBody = body
    await json(route, 401, { error: 'invalid_credentials' })
  })

  await page.goto(`/r/${SLUG}/terminal`)
  const radios = page.getByRole('radio')
  await expect(radios).toHaveCount(2)
  await expect(page.getByRole('radio', { name: /Dawit Haile/ })).toContainText('Runner')
  expect(rosterBody).toEqual({ restaurant_slug: SLUG, kiosk_token: TOKEN })

  // keyboard: arrow moves focus, Enter selects
  await radios.first().focus()
  await page.keyboard.press('ArrowRight')
  await expect(radios.nth(1)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeDisabled()

  await page.keyboard.type('4829')
  await expect(page.getByText('4 of 4 digits entered')).toBeAttached()
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toContainText('Could not sign in')
  await expect(page.getByText('0 of 4 digits entered')).toBeAttached()
  expect(loginBody).toEqual({
    restaurant_slug: SLUG,
    kiosk_token: TOKEN,
    profile_id: '22222222-2222-4222-8222-222222222222',
    pin: '4829',
  })

  // "Not you?" returns to the tiles
  await page.getByRole('button', { name: 'Not you?' }).click()
  await expect(page.getByRole('heading', { name: 'Enter your PIN' })).toHaveCount(0)
  await expect(radios).toHaveCount(2)
})
