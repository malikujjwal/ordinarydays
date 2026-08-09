import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

/**
 * Unmounts anything a test rendered. Testing Library's auto-cleanup hooks into globals
 * Vitest does not install, so without it a component stays mounted into the next test and
 * `getByRole` starts finding two of everything.
 */
afterEach(cleanup);

/**
 * `expo-constants` reads the manifest Expo injects at bundle time. Under Vitest there is no
 * bundler and no manifest, so it is stubbed here rather than in each test file — every
 * module that touches configuration reaches it through `Constants.expoConfig`, and a stub
 * per file would drift.
 *
 * The values are the ones `app.config.ts` produces for the **local** profile, so a test that
 * does not care about configuration gets the same answers a laptop does. A test that does
 * care overrides `Constants.expoConfig` for its own case.
 */
vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      name: 'Ordinary Days',
      version: '0.0.0',
      extra: { profile: 'local' },
      hostUri: undefined,
    },
  },
}));
