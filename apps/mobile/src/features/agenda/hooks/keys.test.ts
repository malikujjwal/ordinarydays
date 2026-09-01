import { describe, expect, it } from 'vitest';
import { PLAN_ACTIVITY_FLOORS_KEY } from '@/lib/planActivityFloors';
import { ANYTIME_KEY, plansProjectionKey } from './keys';

describe('ANYTIME_KEY', () => {
  it('extends the shared activity-list invalidation root with saved', () => {
    expect(ANYTIME_KEY).toEqual(['activities', 'saved']);
  });
});

describe('Plans keys', () => {
  it('keeps projection and activity floors under the Plans root', () => {
    expect(plansProjectionKey('America/New_York')).toEqual([
      'plans',
      'projection',
      'America/New_York',
    ]);
    expect(PLAN_ACTIVITY_FLOORS_KEY).toEqual(['plans', 'activity-floors']);
  });
});
