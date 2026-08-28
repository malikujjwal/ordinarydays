import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.LISTS_VISUAL_PORT ?? 8083);
process.env.E2E_WEB_PORT = String(WEB_PORT);

export default defineConfig({
  testDir: './visual-specs',
  timeout: 30_000,
  expect: { timeout: 10_000, toHaveScreenshot: { animations: 'disabled' } },
  workers: 1,
  retries: process.env.CI === undefined ? 0 : 1,
  reporter:
    process.env.CI === undefined ? 'list' : [['github'], ['html', { open: 'never' }]],
  snapshotPathTemplate: '{testDir}/snapshots/{testFileName}/{arg}{ext}',
  outputDir: '../test-results/lists-visual',
  globalSetup: './lists-visual-global-setup.mjs',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
