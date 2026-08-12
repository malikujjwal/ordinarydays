import { describe, expect, it } from 'vitest';
import { ANYTIME_KEY } from './keys';

describe('ANYTIME_KEY', () => {
  it('extends the shared activity-list invalidation root with saved', () => {
    expect(ANYTIME_KEY).toEqual(['activities', 'saved']);
  });
});
