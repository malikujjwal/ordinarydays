import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `@od/mobile` under jsdom, with `react-native` aliased to `react-native-web` (P1-31).
 *
 * The reasoning for the alias over a Babel/Flow transform is written out once, in
 * `packages/ui/vitest.config.ts`. Both workspaces are configured identically on purpose: a
 * primitive and the screen that consumes it must be asserted the same way, and two different
 * resolutions of `react-native` in one repository is how a component passes in `ui` and
 * fails in `mobile` for reasons nobody can see in the diff.
 */
export default defineConfig({
  resolve: {
    /**
     * Array form with anchored patterns, not the object shorthand.
     *
     * `{ '@': './src' }` would also rewrite `@testing-library/react` to
     * `./src/testing-library/react`, because the shorthand matches a bare prefix. Anchoring
     * on `@/` is what keeps the app's own alias from swallowing every scoped package.
     * `react-native` is anchored for the mirror-image reason: an unanchored match would
     * rewrite `react-native-web` to `react-native-web-web`.
     */
    alias: [
      { find: /^react-native$/, replacement: 'react-native-web' },
      /**
       * The same `react-native-svg` stub `packages/ui` uses, for the same reason and from the
       * same file rather than a copy — the full note is in `packages/ui/vitest.config.ts`.
       * Needed here from P1-23 on: the shell's FAB and the chooser rows render `@od/ui`
       * icons, so the moment a screen test mounts one, this workspace hits the untranspiled
       * source too. A second copy of the stub would be a second thing to keep in step.
       */
      {
        find: /^react-native-svg$/,
        replacement: fileURLToPath(
          new URL('../../packages/ui/test/svg-stub.tsx', import.meta.url),
        ),
      },
      /**
       * `react-native-safe-area-context` is stubbed, not resolved — the reasoning is written
       * out at the top of `test/safe-area-stub.tsx`. Short version: its package entry under
       * the `react-native` condition is untranspiled TypeScript, and its compiled build
       * reaches into `react-native`'s Flow source, so both routes end in a parse error
       * several modules from anything this repository wrote.
       */
      {
        find: /^react-native-safe-area-context$/,
        replacement: fileURLToPath(new URL('./test/safe-area-stub.tsx', import.meta.url)),
      },
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./src/', import.meta.url)),
      },
    ],
    /**
     * `.web.tsx` resolves first, as it does in the web bundler and in `packages/ui`'s config
     * — where the full reasoning is written out. Needed here from P1-22 on: `@od/ui`'s barrel
     * reaches a platform-forked file (`pickerSurface`), and a screen test that resolved the
     * native fork would be loading a native module jsdom cannot render.
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
  define: {
    /**
     * Expo's "this is not a production bundle" flag, injected by Metro at build time and
     * therefore absent under Vitest. `src/lib/apiClient.ts` reads it for `strictResponses`,
     * and without this the module throws `__DEV__ is not defined` on import.
     *
     * `true` is correct for a test run: it is the setting that makes a response failing its
     * schema throw rather than be quietly passed through, which is what a test should do.
     */
    __DEV__: 'true',
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    server: {
      /**
       * Both libraries publish **untranspiled source** under the `react-native` condition
       * that the `react-native` → `react-native-web` alias puts this workspace on, so Node
       * parses their TypeScript and fails with `Unexpected token 'typeof'` — an error that
       * surfaces as a test file which will not import, several modules from the cause.
       * Inlining hands them to Vite's transform instead.
       *
       * `react-native-svg` for the reason written out in `packages/ui/vitest.config.ts`;
       * `react-native-safe-area-context` is new here, because `packages/ui` never mounts a
       * provider and `apps/mobile`'s screens do.
       */
      deps: { inline: ['react-native-svg', 'react-native-safe-area-context'] },
    },
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
         * Pure projections — every optimistic update must agree with what the server will
         * return, or the row visibly flips back. Nothing matches this glob yet; the first
         * `model/` directory lands against a live 95% gate.
         */
        'src/features/*/model/**': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },

        /**
         * **`apps/mobile`'s overall floor from `testing.md` §9, armed by P1-31.**
         *
         * P0-24 wrote these numbers and left them commented out, because the three files in
         * `src/` all import `react-native`, `expo-constants` or React, and covering them
         * needed the environment this task builds. Arming them before that existed would
         * have failed `pnpm test` on day one, and the only ways to make it pass would have
         * been to exclude the files being measured or to assert against a mocked module
         * graph — both of which produce a green number that means nothing.
         */
        statements: 60,
        branches: 50,
        functions: 60,
        lines: 60,
      },
    },
  },
});
