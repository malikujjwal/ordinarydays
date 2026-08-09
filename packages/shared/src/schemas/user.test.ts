import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { PatchUserInput, User } from '../types/user.js';
import { type patchUserInput, user } from './user.js';

/**
 * The schema and the interface describe one stored shape. Nothing forces them to agree, so
 * this does — in both directions, because a one-way assertion passes happily when one side
 * gains a field the other lacks. Same shape as `error.test.ts`.
 */
describe('the schema and the interface are the same shape', () => {
  it('User is assignable both ways', () => {
    expectTypeOf<z.infer<typeof user>>().toEqualTypeOf<User>();
  });

  it('PatchUserInput is assignable both ways', () => {
    expectTypeOf<z.infer<typeof patchUserInput>>().toEqualTypeOf<PatchUserInput>();
  });
});

const valid: User = {
  userId: 'usr_local_dev',
  displayName: 'Dev',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  createdAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
  schemaVersion: 1,
};

describe('the profile', () => {
  it('accepts the minimal shape a new account ships with', () => {
    expect(user.safeParse(valid).success).toBe(true);
  });

  it('accepts the seeded dev profile, every optional field present', () => {
    expect(
      user.safeParse({
        ...valid,
        defaultReminderOffset: -15,
        allDayReminderHour: 9,
        quietHours: { enabled: true, start: '22:00', end: '07:00' },
        defaultLists: { groceries: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2' },
        onboardingState: 'done',
      }).success,
    ).toBe(true);
  });
});

describe('defaultReminderOffset — three states, and the difference matters', () => {
  it.each([
    ['absent, which is Off on a new account', undefined],
    ['null, which is an explicit Off', null],
    ['0, which is a real At the time reminder', 0],
    ['a negative offset', -15],
    ['the furthest permitted, a week', -10080],
  ])('accepts %s', (_why, offset) => {
    expect(user.safeParse({ ...valid, defaultReminderOffset: offset }).success).toBe(
      true,
    );
  });

  it.each([
    ['a positive offset, which would be after the start', 15],
    ['more than a week before', -10081],
    ['a fractional minute', -15.5],
  ])('rejects %s', (_why, offset) => {
    expect(user.safeParse({ ...valid, defaultReminderOffset: offset }).success).toBe(
      false,
    );
  });
});
