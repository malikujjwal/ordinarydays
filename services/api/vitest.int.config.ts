import { defineConfig } from 'vitest/config';

/**
 * The integration suite: tests that need DynamoDB Local running.
 *
 * Separate from `vitest.config.ts` on purpose. `pnpm test` must stay runnable with nothing
 * installed but Node — a unit suite that fails because Docker is not up trains people to
 * ignore red, and it is the reason `turbo.json` gives `test:int` its own task with
 * `cache: false`.
 *
 *   docker compose up -d
 *   pnpm --filter @od/api ddb:create-table
 *   pnpm --filter @od/api test:int
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    // A container round trip is slower than a unit test, and the table waiters in
    // `create-local-table.ts` are allowed up to 30 s each.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One database, one table name: parallel files would delete each other's table.
    fileParallelism: false,
    /**
     * The environment `lib/config.ts` parses at module load, mirroring `vitest.config.ts`.
     *
     * Added in P1-04 to fix a regression from **P1-01**: making `AUTH_MODE` required updated
     * the unit suite's `env` block and nothing else, so every integration file that reached
     * `lib/ddb.ts` began failing with `Invalid environment: AUTH_MODE` — invisible to
     * `pnpm test`, which does not run this suite. Setting it here rather than at the top of
     * each file is what stops the next required variable doing the same thing.
     *
     * A file that needs different values still overrides them at its top, which is where the
     * `DDB_ENDPOINT` and per-file `TABLE_NAME` conventions already live.
     */
    env: {
      STAGE: 'local',
      AUTH_MODE: 'local',
      MEDIA_BUCKET: 'od-media-local',
      LOG_LEVEL: 'fatal',
    },
  },
});
