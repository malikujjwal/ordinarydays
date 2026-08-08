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
