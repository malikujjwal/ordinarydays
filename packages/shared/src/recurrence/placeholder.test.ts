import { describe, expect, it } from 'vitest';
import { isSupportedFrequency } from './placeholder.js';

/**
 * Every branch of the placeholder, because the point of the placeholder is that the 100%
 * gate on `recurrence/**` is enforced today. If this file ever stops covering every branch
 * of its subject, `pnpm test` fails — which is exactly the behaviour P2-01 needs to inherit.
 */
describe('isSupportedFrequency', () => {
  it.each(['daily', 'weekly', 'monthly', 'yearly'])('accepts %s', (frequency) => {
    expect(isSupportedFrequency(frequency)).toBe(true);
  });

  it.each(['hourly', 'fortnightly', '', 'DAILY'])('rejects %s', (frequency) => {
    expect(isSupportedFrequency(frequency)).toBe(false);
  });
});
