import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * The web E2E harness (P1-29).
 *
 * ## It runs against the local stack, and only the local stack
 *
 * `testing.md` §6.1 describes running against the deployed dev site after `deploy-dev.yml`.
 * That workflow is Phase 4 (P4-14) and there is nothing deployed to point at yet, so this
 * config drives the three things a laptop already has: DynamoDB Local, the API on `:3000`,
 * and the `expo export --platform web` output served statically. `E2E_BASE_URL` is honoured
 * so that Phase 4 aims it at dev by setting one variable rather than by rewriting this file.
 *
 * Building it locally first is deliberate: a harness that only exists inside a CI workflow is
 * one nobody runs before pushing, which is how E2E suites become permanently red.
 */

/**
 * `__dirname`, not `import.meta.url`. Playwright transpiles this config to CommonJS — the
 * nearest `package.json` has no `"type": "module"` — so `import.meta` is a syntax error at
 * load time rather than something the types would have caught.
 */
const REPO_ROOT = join(__dirname, '..');

const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 8082);
const API_PORT = Number(process.env.E2E_API_PORT ?? 3000);
const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${WEB_PORT}`;

/**
 * The API's whole environment, stated here rather than read from `services/api/.env.local`.
 *
 * The dev server's own script loads that file, and it names `od-main-local` — the table a
 * developer's `pnpm dev` is using. An E2E run that seeded over it would destroy the data
 * somebody was looking at, and `--reset` makes that a dropped table rather than some stray
 * rows. Its own table costs one variable, which is the same trade P1-28 made for the
 * integration suite.
 */
const API_ENV = {
  STAGE: 'local',
  AUTH_MODE: 'local',
  LOG_LEVEL: 'warn',
  TABLE_NAME: process.env.E2E_TABLE_NAME ?? 'od-main-e2e',
  DDB_ENDPOINT: process.env.DDB_ENDPOINT ?? 'http://localhost:8000',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'localsecret',
  MEDIA_BUCKET: 'od-media-local',
  PORT: String(API_PORT),
};

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
    process.env.CI === undefined ? [['list']] : [['github'], ['html', { open: 'never' }]],

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

  /**
   * Both servers, started only when nothing is already listening. `reuseExistingServer` is off
   * in CI so a run can never silently test a stale process.
   *
   * The API is started through `tsx` directly rather than through `pnpm --filter @od/api dev`:
   * that script is `tsx watch` with `--env-file-if-exists=.env.local`, and neither the watcher
   * nor the developer's env file belongs in a test run.
   */
  webServer: [
    {
      command: 'pnpm --filter @od/api exec tsx src/local.ts',
      url: `http://127.0.0.1:${API_PORT}/v1/health`,
      // Both commands run from the repository root. Playwright's default is the config's own
      // directory, which would make every path here relative to `e2e/`.
      cwd: REPO_ROOT,
      env: API_ENV,
      reuseExistingServer: process.env.CI === undefined,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node e2e/serve-export.mjs',
      url: BASE_URL,
      cwd: REPO_ROOT,
      env: { E2E_WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: process.env.CI === undefined,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
