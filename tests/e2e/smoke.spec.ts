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
