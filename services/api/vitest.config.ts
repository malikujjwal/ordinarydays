import { defineConfig } from 'vitest/config';

/**
 * Minimal, matching the other packages. Coverage thresholds are P0-24; the DynamoDB Local
 * integration harness is P0-21 and lives under `test/`, not here.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
