import { defineConfig } from 'vitest/config';

/**
 * Minimal on purpose, and identical in shape to `packages/shared`'s. Coverage thresholds
 * and the workspace-wide Vitest wiring are P0-24. Component tests arrive with the
 * primitives in P1-22 and will need a DOM environment then; `node` is correct while this
 * package has no components.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
