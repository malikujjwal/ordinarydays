import { defineConfig } from 'vitest/config';

/**
 * The integration suite: tests that need DynamoDB Local running.
 *
 * Separate from `vitest.config.ts` on purpose. `pnpm test` must stay runnable with nothing
 * installed but Node — a unit suite that fails because Docker is not up trains people to
 * ignore red, and it is the reason `turbo.json` gives `test:int` its own task with
 * `cache: false`.
 *
 *   pnpm test:int
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
     * It stays off because the current suite is not reliable under database contention. On
     * 2026-08-26, against the in-memory test service, 25 files / 502 tests ran serially in
     * 122 s and passed; eight workers finished in 38 s but four tests failed under that load.
     * That replaces the stale eight-file measurement: parallel is now faster, but not yet a
     * truthful gate. Diagnose those failures before enabling it. Do not turn it on or
     * leave it off for the old table-interference reason, which no longer applies.
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
     * Everything here is the same for every file. `DDB_ENDPOINT` defaults to the disposable
     * in-memory service on port 8002, while an explicit value can still point the suite at an
     * externally managed DynamoDB Local. Only the per-file `TABLE_NAME` is set by
     * `test/integration/harness.ts` when it is imported, which is why no test file sets an
     * environment variable of its own any more (P1-28).
     */
    env: {
      STAGE: 'local',
      AUTH_MODE: 'local',
      MEDIA_BUCKET: 'od-media-local',
      WEB_ORIGINS: 'http://localhost:8081',
      LOG_LEVEL: 'fatal',
      DDB_ENDPOINT: process.env.DDB_ENDPOINT ?? 'http://127.0.0.1:8002',
      /**
       * MinIO, brought up by the same `pnpm test:int` that starts DynamoDB Local (P3-21).
       *
       * Overridable like `DDB_ENDPOINT`, for an externally managed store. Unlike it, the
       * **credentials are fixed rather than inherited**: DynamoDB Local accepts any value,
       * while MinIO checks the signature against its root user, so a developer with a real
       * AWS profile exported would otherwise watch every presigned upload fail with
       * `SignatureDoesNotMatch` for a reason that has nothing to do with the code. These are
       * the compose file's `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD`, and no real
       * credential is involved on a laptop or in CI.
       *
       * Unlike DynamoDB there is **one** bucket rather than one per file: object keys carry a
       * fresh ULID, so files cannot collide, and keeping the local store's shape identical to
       * the deployed one is the whole reason MinIO is here rather than a mock.
       */
      S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:9000',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'localsecret',
    },
  },
});
