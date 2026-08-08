import { defineConfig } from 'vitest/config';

/**
 * Minimal on purpose. Coverage thresholds and the workspace-wide Vitest wiring are P0-24;
 * this config exists so P0-07's own tests can run.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
