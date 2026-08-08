import { defineConfig } from 'vitest/config';

/**
 * Minimal, matching `packages/shared` and `packages/ui`. Coverage thresholds and the
 * workspace-wide wiring are P0-24; the CDK assertion tests under `test/` are P0-26.
 */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // `NodejsFunction` runs esbuild at synth time, so a construct test that touches one
    // genuinely compiles TypeScript. That is well past Vitest's 5s default on a cold run,
    // and a timeout there looks like a test failure rather than a slow bundle.
    testTimeout: 60_000,
  },
});
