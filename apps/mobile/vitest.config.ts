import { defineConfig } from 'vitest/config';

/**
 * `@od/mobile` has no unit tests yet, and that is not an oversight to fix here.
 *
 * What is testable in this workspace today — `apiClient.ts`, `useHealth.ts` — imports
 * `react-native`, `expo-constants` and React. Running those under Vitest needs the React
 * Native transform and Testing Library setup that arrives with the primitives in **P1-22**,
 * and standing that up now to cover two files would be a lot of configuration protecting
 * very little. The screen itself is covered end to end by Playwright and Maestro
 * (`testing.md` §6), which is the level `definition-of-done.md` §3 puts mobile screens at:
 * "Journeys, not percentage".
 *
 * So this file exists to arm the gate, not to claim coverage. `passWithNoTests` keeps
 * `pnpm test` green while the suite is empty, and the thresholds below start biting the
 * moment P1 adds the first `model/` directory — which is exactly where the numbers that
 * matter live.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      /**
       * `testing.md` §9 excludes Expo Router route files by name: their logic lives in
       * feature components, which are covered. `app/**` is therefore absent from `include`
       * entirely rather than listed here.
       */
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      thresholds: {
        /**
         * The numbers that actually matter, armed today. Pure projections — every
         * optimistic update must agree with what the server will return, or the row
         * visibly flips back. Nothing matches this glob yet, which is the point: the first
         * `model/` directory lands against a live 95% gate.
         */
        'src/features/*/model/**': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },

        /**
         * **`apps/mobile`'s overall floor — 60/50/60/60 in `testing.md` §9 — is written
         * here but not yet armed, and P0-24 should not pretend otherwise.**
         *
         * The three files in `src/` all import `react-native`, `expo-constants` or React,
         * so covering them needs the React Native transform and Testing Library setup that
         * **P1-22** brings with the primitives. Arming the floor before that environment
         * exists would fail `pnpm test` on day one, and the only ways to make it pass would
         * be to exclude the files it is meant to measure or to write assertions against a
         * mocked module graph — both of which produce a green number that means nothing.
         *
         * Uncomment with P1-22, when there is something real to measure:
         *
         *   statements: 60, branches: 50, functions: 60, lines: 60,
         */
      },
    },
  },
});
