import { defineConfig } from 'vitest/config';

/**
 * `@od/ui` under jsdom, with `react-native` aliased to `react-native-web` (P1-31).
 *
 * ## Why the alias rather than a Flow transform
 *
 * `react-native` ships **untranspiled Flow-typed source**: its entry point is not valid
 * TypeScript or JavaScript, and Vitest's esbuild transform cannot parse it. The two ways out
 * are to run `@react-native/babel-preset` over `node_modules/react-native` — the setup Jest
 * uses — or to resolve `react-native` to `react-native-web`, which ships plain compiled
 * JavaScript and needs no transform at all.
 *
 * The alias wins here for a reason specific to this project rather than for convenience.
 * React Native Web is not a shim we tolerate — it is a **first-class shipping target**
 * (ADR-001): the same component file is the iOS app and the web app, and the web build is
 * what Playwright drives on every pull request. Testing the primitives as they render on
 * that target tests something the product actually ships, and it keeps one transform
 * pipeline in the repository instead of two. Adding the Babel preset would mean a second
 * toolchain, a slower suite, and a `node_modules` transform allow-list to maintain.
 *
 * What the alias costs, stated plainly: these tests do **not** exercise the iOS host
 * components. A primitive that renders correctly here and wrongly on iOS is a gap this
 * config cannot close, and it is closed instead by Maestro on the simulator (P1-29) and by
 * the physical-device criterion. Anything genuinely platform-divergent belongs in a
 * `.ios.tsx`/`.web.tsx` pair from the sanctioned list in `tech-stack.md` §3.5, not in a test
 * that quietly passes on one platform.
 */
export default defineConfig({
  resolve: {
    // Anchored, so `react-native-web` is not itself rewritten to `react-native-web-web`.
    // `apps/mobile` uses the same form and the same reasoning.
    alias: [{ find: /^react-native$/, replacement: 'react-native-web' }],
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
      thresholds: {
        // `testing.md` §9. `definition-of-done.md` §3 sets the real bar in behaviour rather
        // than percentage: each primitive renders, each interactive one gets one interaction
        // test and one accessibility assertion. P1-22 is what makes these numbers mean
        // something; this config is what lets it.
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 75,
      },
    },
  },
});
