import { expect, test } from '@playwright/test'

test('app loads', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CafeOS')
})

test('tenant route skeleton resolves slug', async ({ page }) => {
  await page.goto('/r/demo-cafe')
  await expect(page.getByTestId('tenant-slug')).toHaveText('demo-cafe')
})
