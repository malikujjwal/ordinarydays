import { defineConfig } from 'vitest/config';

/**
 * Minimal, matching `packages/shared` and `packages/ui`. Coverage thresholds and the
 * workspace-wide wiring are P0-24; the CDK assertion tests under `test/` are P0-26.
 */
export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
  },
});
