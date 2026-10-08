import { expect, test } from '@playwright/test'

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
