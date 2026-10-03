import { defineConfig, devices } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// In sandboxes without a downloaded browser, set PW_CHROMIUM_DIR (e.g. /opt/pw-browsers)
// to use a pre-installed Chromium. Never run `playwright install` there.
function findChromium(): string | undefined {
  const explicit = process.env.PW_CHROMIUM_PATH
  if (explicit) return explicit
  const dir = process.env.PW_CHROMIUM_DIR
  if (!dir || !fs.existsSync(dir)) return undefined
  const entry = fs.readdirSync(dir).find((d) => d.startsWith('chromium-'))
  if (!entry) return undefined
  const candidate = path.join(dir, entry, 'chrome-linux', 'chrome')
  return fs.existsSync(candidate) ? candidate : undefined
}

const executablePath = findChromium()

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], ...(executablePath ? { launchOptions: { executablePath } } : {}) },
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
