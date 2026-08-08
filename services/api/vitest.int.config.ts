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
  },
});
