import { expect, test } from '@playwright/test'
import { expectNoSeriousA11yViolations } from './a11y'

test('app loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CafeOS')
})

test('unauthenticated tenant route redirects to the slug login', async ({ page }) => {
  await page.goto('/r/demo-cafe')
  await expect(page).toHaveURL(/\/r\/demo-cafe\/login$/)
})

test('unauthenticated platform route redirects to the platform login', async ({ page }) => {
  await page.goto('/platform')
  await expect(page).toHaveURL(/\/platform\/login$/)
})

// Phase 2 shell routes: module placeholders and the generic station board sit behind the same auth guard.
for (const path of ['/r/demo-cafe/pos', '/r/demo-cafe/stations/11111111-1111-4111-8111-111111111111']) {
  test(`unauthenticated ${path} redirects to the slug login`, async ({ page }) => {
    await page.goto(path)
    await expect(page).toHaveURL(/\/r\/demo-cafe\/login$/)
  })
}

// Phase 11 a11y smoke: the two sign-in surfaces (no session needed)
for (const [path, label] of [
  ['/r/demo-cafe/login', 'Tenant sign-in'],
  ['/platform/login', 'Platform sign-in'],
] as const) {
  test(`a11y: ${label} has no serious or critical axe violations`, async ({ page }) => {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
    await expectNoSeriousA11yViolations(page, label)
  })
}
