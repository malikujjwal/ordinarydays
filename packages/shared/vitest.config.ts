import { defineConfig } from 'vitest/config';

/**
 * `@od/shared` — the package with the two directories the whole test strategy hangs on.
 *
 * The path-scoped thresholds for `recurrence/**` and `money/**` are **100% statements and
 * branches**, and they are configured here before either directory holds real code
 * (`phase-00-foundations.md` P0-24). That ordering is the point: R1 in the roadmap's risk
 * register names "the coverage threshold on `recurrence/**` is lowered, even to 99%" as a
 * trigger signal, and a gate written after the engine is a gate fitted to the engine.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    /**
     * Vitest's default is 5 s, which is right for a unit test and wrong for the handful of
     * **module-surface guards** in this package — `templates.test.ts` and
     * `templateChoices.test.ts` prove an absence by `await import`ing a barrel, so they pay
     * for transforming a module graph inside the test body rather than during collection.
     * Those two sit at roughly two seconds on their own and cross five under the parallel
     * load `turbo run test` puts on the transform pool, which made `pnpm verify` fail on a
     * suite where every assertion passed.
     *
     * Raised in P3-24, when four new test files were enough to tip it. The number is not a
     * performance budget — nothing here asserts a duration — it is headroom so a green suite
     * reports green. If a test ever genuinely needs twenty seconds, that is the bug.
     */
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      /**
       * `testing.md` §9's exclusion list, applied literally: entry points and type-only
       * modules. A barrel is a list of re-exports with no behaviour — counting it inflates
       * the number without testing anything, which is worse than leaving it out.
       */
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/**/index.ts',
        'src/types/**',
        // `src/openapi.ts` is deliberately NOT excluded. It is pure — it builds a document
        // and writes nothing — so it is covered like anything else, and the file-writing
        // half lives in `scripts/gen-openapi.ts`.
      ],
      thresholds: {
        // `testing.md` §9, `packages/shared` overall.
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
        'src/recurrence/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/money/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        'src/activity/bucket.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // `definition-of-done.md` §4's rationale applies verbatim: a rank that sorts wrong is
        // discovered by a user, on two devices showing two orders (P3-03).
        'src/rank/**': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
});
