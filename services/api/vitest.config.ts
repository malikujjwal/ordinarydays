import { defineConfig } from 'vitest/config';

/**
 * The unit suite. It must run with **nothing installed but Node** — the DynamoDB Local
 * tests live in `vitest.int.config.ts` and are a separate Turbo task, because a unit suite
 * that fails when Docker is down trains people to ignore red.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * The environment `lib/config.ts` parses at module load.
     *
     * Set here rather than at the top of each test file, which is what `testing.md` §4.3
     * already describes and what P1-05 made true: any test that imports something reaching
     * `lib/ddb.ts` — which is now every repository test — otherwise fails on a missing
     * `TABLE_NAME` before a single assertion runs, and the fix per file is five lines of
     * boilerplate that must stay in step across all of them.
     *
     * A test that needs different values overrides them with `vi.stubEnv` plus
     * `vi.resetModules()`, which is what P1-02's startup-guard tests will do.
     */
    env: {
      STAGE: 'local',
      /**
       * P1-01. No default in the schema, so the suite states it like any other environment.
       * `local` is the only mode with an implementation; a test that needs the other one
       * stubs the provider through `createApp({ identityProvider })` rather than switching
       * modes, because the mode selects a provider and the provider is what behaviour hangs
       * off.
       */
      AUTH_MODE: 'local',
      TABLE_NAME: 'od-main-local',
      MEDIA_BUCKET: 'od-media-local',
      WEB_ORIGINS: 'http://localhost:8081',
      LOG_LEVEL: 'fatal',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      /**
       * `testing.md` §9's list: entry points, `local.ts`, and type-only modules.
       *
       * `index.ts` is the Lambda handler export and `local.ts` is the dev server — both are
       * wiring whose behaviour is asserted by starting them, not by unit tests. `app-env.ts`
       * declares Hono's context types and emits nothing.
       */
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/local.ts',
        'src/app-env.ts',
        'src/lib/ddb.ts',
      ],
      thresholds: {
        // `testing.md` §9, `services/api` overall.
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
        // Per-layer, from the same table. Neither directory exists until Phase 1; the
        // thresholds are armed now for the same reason the recurrence gate is.
        'src/services/**': { statements: 90, branches: 85, functions: 90, lines: 90 },
        'src/repositories/**': { statements: 85, branches: 75, functions: 85, lines: 85 },
      },
    },
  },
});
