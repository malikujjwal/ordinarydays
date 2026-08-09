import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Reminder } from '../types/reminder.js';
import { reminder, reminderInput } from './reminder.js';

describe('the schema and the interface are the same shape', () => {
  it('Reminder is assignable both ways', () => {
    expectTypeOf<z.infer<typeof reminder>>().toEqualTypeOf<Reminder>();
  });
});

const valid = {
  reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  userId: 'usr_local_dev',
  offsetMinutes: -15,
  channel: 'push',
};

describe('the stored reminder', () => {
  it('accepts a well-formed row', () => {
    expect(reminder.safeParse(valid).success).toBe(true);
  });

  it('accepts 0, which is a real At the time reminder', () => {
    expect(reminder.safeParse({ ...valid, offsetMinutes: 0 }).success).toBe(true);
  });

  it.each([
    ['a positive offset, which would fire after the start', 15],
    ['more than a week before', -10081],
    ['a fractional minute', -15.5],
  ])('rejects %s', (_why, offsetMinutes) => {
    expect(reminder.safeParse({ ...valid, offsetMinutes }).success).toBe(false);
  });

  /**
   * The field the whole per-user design rests on. A row without it could not be filtered to
   * the caller, which is what stops one person's "leave in 15 minutes" reaching everybody on
   * a shared plan.
   */
  it('rejects a row with no userId', () => {
    const { userId: _dropped, ...withoutUser } = valid;
    expect(reminder.safeParse(withoutUser).success).toBe(false);
  });

  it('rejects a channel other than push, which is all v1 has', () => {
    expect(reminder.safeParse({ ...valid, channel: 'email' }).success).toBe(false);
  });
});

/**
 * The input a client may send. It carries the offset and nothing else — a body that could
 * name a `userId` would let one person set another's reminders, so the field is not merely
 * ignored, it is rejected.
 */
describe('the reminder input', () => {
  it('accepts an offset alone', () => {
    expect(reminderInput.safeParse({ offsetMinutes: -15 }).success).toBe(true);
  });

  it('rejects a client-supplied userId', () => {
    expect(
      reminderInput.safeParse({ offsetMinutes: -15, userId: 'usr_someone_else' }).success,
    ).toBe(false);
  });

  it('rejects a client-supplied channel', () => {
    expect(reminderInput.safeParse({ offsetMinutes: -15, channel: 'push' }).success).toBe(
      false,
    );
  });
});

/**
 * Criterion 23's guard, running from the phase in which there is nothing to leak — which is
 * the only time it is cheap to enforce.
 *
 * `Activity` has no `reminders[]`, and `CreateActivityInput.reminders` is a different shape
 * that writes rows for the creator alone. The two look like they should be one type, and in
 * Phase 6 merging them becomes a leak of one user's reminders to everybody on a shared plan.
 * ADR-047.
 */
describe('Activity has no reminders array', () => {
  it('the word appears nowhere in types/activity.ts', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'types', 'activity.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    expect(code).not.toMatch(/\breminders\b/);
  });
});
