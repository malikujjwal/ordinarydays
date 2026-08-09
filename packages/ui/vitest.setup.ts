import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmounts anything a test rendered, after every test.
 *
 * Testing Library's auto-cleanup hooks into globals that Vitest does not install by default,
 * so without this a component stays mounted into the next test and `getByRole` starts
 * finding two of everything — a failure that reads as a bug in the second test and is
 * actually a leak from the first.
 */
afterEach(cleanup);
