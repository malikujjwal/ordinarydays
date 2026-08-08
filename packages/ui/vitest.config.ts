import { defineConfig } from 'vitest/config';

/**
 * `packages/ui` has no components yet — P1-22 writes the theme and the primitives, and
 * they will need a DOM environment then. `node` is correct while the package's only source
 * file is a barrel.
 *
 * The thresholds are armed now regardless, so the first primitive lands against a gate
 * rather than after one.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        // `testing.md` §9. `definition-of-done.md` §3 sets the bar in behaviour rather than
        // percentage: each primitive renders, and each interactive one gets one interaction
        // test and one accessibility assertion.
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});
