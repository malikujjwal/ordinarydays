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
      },
    },
  },
});
