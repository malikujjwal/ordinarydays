import { fileURLToPath } from 'node:url';
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
    alias: [
      // Anchored, so `react-native-web` is not itself rewritten to `react-native-web-web`.
      // `apps/mobile` uses the same form and the same reasoning.
      { find: /^react-native$/, replacement: 'react-native-web' },
      /**
       * `react-native-svg` is stubbed under test, not resolved.
       *
       * It declares `"react-native": "src/index.ts"`, so under the condition this config
       * puts us on it resolves to **untranspiled TypeScript** and Node fails to parse it;
       * its published `lib/module` build then fails differently. Either way the error
       * surfaces as a barrel that will not import, several files from the cause, saying
       * nothing about SVG.
       *
       * A stub is the right answer rather than a workaround: **nothing in this suite asserts
       * SVG rendering.** The icon tests assert that a control has the right role and
       * accessible name, that a tile is hidden from assistive tech, and that a disabled
       * button does not fire — none of which depends on a real `<path>`. The shapes
       * themselves are reviewed in the token gallery, in a browser, where the real library
       * loads through Metro.
       */
      {
        find: /^react-native-svg$/,
        replacement: fileURLToPath(new URL('./test/svg-stub.tsx', import.meta.url)),
      },
      /**
       * `@react-native-community/datetimepicker` is stubbed for a different reason from
       * `react-native-svg`: it is a **native module**. On iOS it renders a real
       * `UIDatePicker`, so there is nothing for jsdom to render even in principle. The wheel
       * is asserted by Maestro on the simulator (P1-29).
       *
       * Only the fork-parity test reaches it — everything else resolves
       * `pickerSurface.web.tsx` through `extensions` below. Added in P1-22.
       */
      /**
       * `react-native-safe-area-context`, stubbed for the reason written at the top of
       * `test/safe-area-stub.tsx`. Needed from the moment `Sheet` began reading the bottom
       * inset so its last control clears the home indicator.
       */
      {
        find: /^react-native-safe-area-context$/,
        replacement: fileURLToPath(new URL('./test/safe-area-stub.tsx', import.meta.url)),
      },
      {
        find: /^@react-native-community\/datetimepicker$/,
        replacement: fileURLToPath(
          new URL('./test/datetimepicker-stub.tsx', import.meta.url),
        ),
      },
    ],
    /**
     * **`.web.tsx` resolves first, exactly as the web bundler does** (`tech-stack.md` §3.5).
     *
     * Without this, an extensionless `./pickerSurface` would resolve to the native fork and
     * the suite would be asserting the one build no browser ever loads — while Playwright,
     * the token gallery and the deployed web app all run the other one. The alias to
     * `react-native-web` at the top of this file already committed this workspace to testing
     * the web target; this makes platform-forked files follow the same rule instead of
     * quietly diverging from it.
     *
     * The remaining entries are Vite's defaults, restated because supplying `extensions` at
     * all replaces them.
     */
    extensions: [
      '.web.tsx',
      '.web.ts',
      '.mjs',
      '.js',
      '.mts',
      '.ts',
      '.jsx',
      '.tsx',
      '.json',
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    server: {
      deps: {
        /**
         * `react-native-svg` publishes untranspiled source under the `react-native`
         * condition, and the alias in `resolve` puts us on that condition. Left external,
         * Node parses its TypeScript and fails with `Unexpected token 'typeof'` — which
         * presents as a barrel that will not import, several files away from the cause.
         *
         * Inlining hands it to Vite's transform instead. Added in P1-22, the first task to
         * import an icon: the packages already here (`react-native-web`) ship compiled
         * JavaScript and needed nothing.
         */
        inline: ['react-native-svg'],
      },
    },
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
