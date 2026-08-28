import { defineConfig, devices } from '@playwright/test';

/**
 * The web E2E harness (P1-29).
 *
 * ## It runs against the local stack, and only the local stack
 *
 * `testing.md` §6.1 describes running against the deployed dev site after `deploy-dev.yml`.
 * That workflow is Phase 4 (P4-14) and there is nothing deployed to point at yet, so this
 * config drives the three things a laptop already has: DynamoDB Local, an isolated API,
 * and the `expo export --platform web` output served statically. `E2E_BASE_URL` is honoured
 * so that Phase 4 aims it at dev by setting one variable rather than by rewriting this file.
 *
 * Building it locally first is deliberate: a harness that only exists inside a CI workflow is
 * one nobody runs before pushing, which is how E2E suites become permanently red.
 */

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8082);
process.env.E2E_WEB_PORT = String(WEB_PORT);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './specs',
  // The export and the container are slower than a unit test, and the first navigation pays
  // for hydrating a React Native Web bundle.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './global-setup.ts',

  /**
   * `retries: 1` in CI and `0` locally, which is `testing.md` §10 rule 2 — and it is **not**
   * retry-until-green. A pass-on-retry is still reported as flaky and still gets quarantined
   * (P1-29: "a flaky E2E test is worse than no E2E test"). The retry exists so one runner
   * hiccup does not block an unrelated merge, not so a real race can hide behind it.
   */
  retries: process.env.CI === undefined ? 0 : 1,
  // One worker: every spec drives the same seeded table as the same user.
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  reporter:
    process.env.CI === undefined
      ? [['list']]
      : [
          ['github'],
          ['html', { open: 'never' }],
          ['json', { outputFile: 'playwright-results.json' }],
        ],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /**
     * The timezone the app, the assertions and the API's `X-Client-Timezone` all agree on.
     * Pinned because the flow chooses a date from a **relative** chip (`Tomorrow`) and then
     * asserts the row lands in a date-bounded bucket; a runner in a different zone would move
     * that boundary underneath the test.
     */
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
