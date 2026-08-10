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
 *   pnpm --filter @od/api test:int
 *
 * `ddb:create-table` is not a prerequisite. Every file builds and drops its own table through
 * `test/integration/harness.ts`; the script is for the dev server, and this suite never touches
 * `od-main-local`.
 */
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    // A container round trip is slower than a unit test, and the table waiters in
    // `create-local-table.ts` are allowed up to 30 s each.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    /**
     * Still serial — but for a **different reason than before**, and the distinction matters
     * to whoever reads this next.
     *
     * It used to say "one database, one table name: parallel files would delete each other's
     * table". That was a correctness constraint, and P1-28's table-per-file removed it: eight
     * files on eight tables cannot interfere, and the suite passes either way.
     *
     * It stays off because parallel is **measurably slower here**. Measured on this suite:
     * serial 54 s wall for 51 s of test time; parallel 69 s wall for 238 s of test time. Eight
     * workers get 3.4x the concurrency out of one DynamoDB Local container and pay 4.6x per
     * request for it, because the container is the bottleneck and it is one process. Turn this
     * on if the suite ever gets a database it can actually saturate; do not turn it on for the
     * reason the old comment ruled out, which no longer applies.
     */
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
     * Everything here is the same for every file. The two values that are not — the per-file
     * `TABLE_NAME` and the local `DDB_ENDPOINT` — are set by `test/integration/harness.ts`
     * when it is imported, which is why no test file sets an environment variable of its own
     * any more (P1-28).
     */
    env: {
      STAGE: 'local',
      AUTH_MODE: 'local',
      MEDIA_BUCKET: 'od-media-local',
      WEB_ORIGINS: 'http://localhost:8081',
      LOG_LEVEL: 'fatal',
    },
  },
});
