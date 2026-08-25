import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { PatchUserInput, User } from '../types/user.js';
import { patchUserInput, user } from './user.js';

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

const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CORNER_SHOP = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';

/**
 * The nested per-slot patch (`api-contract.md` §2.1, `phase-03` §P3-12).
 *
 * The stored map and the patch map are deliberately different shapes, and this is where that
 * asymmetry is pinned: a stored slot is a list id or absent, while a patched slot is a list
 * id, `null` to remove it, or omitted to leave it alone.
 */
describe('defaultLists — a nested per-slot patch, not a replacement map', () => {
  it.each([
    ['one slot set', { groceries: TRADER_JOES }],
    ['one slot cleared', { watch: null }],
    ['a set and a clear together', { groceries: TRADER_JOES, watch: null }],
    [
      'all three slots at once',
      { groceries: TRADER_JOES, watch: CORNER_SHOP, meals: null },
    ],
    ['no slot at all, which touches none of them', {}],
  ])('accepts %s', (_why, defaultLists) => {
    expect(patchUserInput.safeParse({ defaultLists }).success).toBe(true);
  });

  /**
   * A slot value is a list id or nothing. Accepting any non-empty string was the
   * pre-Phase-3 shape and would let a key fragment, a title or another entity's id be stored
   * as a destination that nothing can ever resolve.
   */
  it.each([
    ['a bare string that is not a list id', { groceries: 'groceries' }],
    ['another entity id', { groceries: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2' }],
    ['an empty string', { groceries: '' }],
    ['a slot that is not one of the three', { shopping: TRADER_JOES }],
  ])('rejects %s', (_why, defaultLists) => {
    expect(patchUserInput.safeParse({ defaultLists }).success).toBe(false);
  });

  /** Clearing removes the key, so a stored null is a state no reader should ever meet. */
  it('rejects a null in the stored profile, where clearing removes the key instead', () => {
    expect(user.safeParse({ ...valid, defaultLists: { groceries: null } }).success).toBe(
      false,
    );
  });

  it('rejects a stored value that is not a list id', () => {
    expect(
      user.safeParse({ ...valid, defaultLists: { groceries: 'Groceries' } }).success,
    ).toBe(false);
  });
});
