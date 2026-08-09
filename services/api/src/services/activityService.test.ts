import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredItem } from '../repositories/migrate.js';
import {
  createActivity,
  deriveScheduleInstants,
  deriveStatus,
  projectDetail,
  toSchedule,
} from './activityService.js';

/**
 * The activity rules (P1-10), with the repository mocked.
 *
 * The three that would be silent if wrong are the ones with the most cases here:
 * `scheduledAtUtc` across a DST boundary, the nesting cap, and the caller-scoped reminder
 * filter — a leak nobody would ever see in their own response.
 */
vi.mock('../repositories/activityRepository.js', () => ({
  createActivity: vi.fn(() => Promise.resolve()),
  newActivityId: vi.fn(() => 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
  newReminderId: vi.fn(() => 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
  getActivityMeta: vi.fn(),
  listParticipants: vi.fn(() => Promise.resolve([])),
}));

const repository = await import('../repositories/activityRepository.js');

const USER = 'usr_local_dev';
const NOW = '2026-08-09T12:00:00.000Z';
const PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9';

const task = (overrides: Record<string, unknown> = {}): CreateActivityInput =>
  ({
    objectKind: 'task',
    type: 'task',
    title: 'Buy milk',
    ...overrides,
  }) as CreateActivityInput;

const written = () => vi.mocked(repository.createActivity).mock.calls[0];

beforeEach(() => {
  vi.mocked(repository.createActivity).mockClear();
  vi.mocked(repository.createActivity).mockResolvedValue(undefined);
  vi.mocked(repository.getActivityMeta).mockReset();
  vi.mocked(repository.listParticipants).mockReset();
  vi.mocked(repository.listParticipants).mockResolvedValue([]);
});

/**
 * Rule 1. `status` is server-derived with one exception, so a client cannot mark something
 * completed by patching a field.
 */
describe('deriveStatus', () => {
  it('is saved with no date — the activity exists, nothing is committed', () => {
    expect(deriveStatus(undefined)).toBe('saved');
  });

  it('is saved when a schedule object carries no date', () => {
    expect(deriveStatus({})).toBe('saved');
  });

  it('is scheduled once a date is committed', () => {
    expect(deriveStatus({ date: '2026-08-09' })).toBe('scheduled');
  });

  it('accepts cancelled from the client, the one status that is not derived', () => {
    expect(deriveStatus({ date: '2026-08-09' }, 'cancelled')).toBe('cancelled');
    expect(deriveStatus(undefined, 'cancelled')).toBe('cancelled');
  });

  it.each(['completed', 'skipped', 'saved', 'scheduled'] as const)(
    'ignores a client-supplied %s and derives instead',
    (requested) => {
      expect(deriveStatus({ date: '2026-08-09' }, requested)).toBe('scheduled');
      expect(deriveStatus(undefined, requested)).toBe('saved');
    },
  );
});

/** Rule 3. Derived, never authoritative over the three wall-clock fields it came from. */
describe('deriveScheduleInstants', () => {
  it('converts a timed activity to a UTC instant', () => {
    expect(
      deriveScheduleInstants({
        date: '2026-08-09',
        time: '19:30',
        timezone: 'America/New_York',
      }),
    ).toEqual({ scheduledAtUtc: '2026-08-09T23:30:00.000Z' });
  });

  /**
   * An all-day activity has **no** instant. Any value here would be an invention — midnight?
   * 9am? whose 9am? — and the product asks the user instead, via `allDayReminderHour`.
   */
  it('derives nothing for an all-day activity', () => {
    expect(
      deriveScheduleInstants({ date: '2026-08-09', timezone: 'America/New_York' }),
    ).toEqual({});
  });

  it('converts endTime too, when there is one', () => {
    expect(
      deriveScheduleInstants({
        date: '2026-08-09',
        time: '19:30',
        endTime: '21:00',
        timezone: 'America/New_York',
      }),
    ).toEqual({
      scheduledAtUtc: '2026-08-09T23:30:00.000Z',
      endAtUtc: '2026-08-10T01:00:00.000Z',
    });
  });

  /**
   * **The case that makes this `date-fns-tz` rather than millisecond arithmetic.** New York
   * is UTC−4 in July and UTC−5 in January; the same wall-clock 09:00 is two different
   * instants, and a conversion using today's offset would be an hour wrong for half the year.
   */
  it('uses the offset in force on the date, not the one in force today', () => {
    const summer = deriveScheduleInstants({
      date: '2026-07-01',
      time: '09:00',
      timezone: 'America/New_York',
    });
    const winter = deriveScheduleInstants({
      date: '2026-01-01',
      time: '09:00',
      timezone: 'America/New_York',
    });

    expect(summer.scheduledAtUtc).toBe('2026-07-01T13:00:00.000Z'); // EDT, UTC−4
    expect(winter.scheduledAtUtc).toBe('2026-01-01T14:00:00.000Z'); // EST, UTC−5
  });

  /** The spring-forward day itself: 03:00 local is the first hour after the gap. */
  it('is correct on the day the clocks change', () => {
    expect(
      deriveScheduleInstants({
        date: '2026-03-08',
        time: '03:00',
        timezone: 'America/New_York',
      }).scheduledAtUtc,
    ).toBe('2026-03-08T07:00:00.000Z');
  });

  it('handles a zone ahead of UTC', () => {
    expect(
      deriveScheduleInstants({
        date: '2026-08-09',
        time: '09:00',
        timezone: 'Asia/Tokyo',
      }).scheduledAtUtc,
    ).toBe('2026-08-09T00:00:00.000Z');
  });
});

describe('createActivity', () => {
  it('stores the caller’s explicit target untouched', async () => {
    const { activity } = await createActivity(
      USER,
      task({ objectKind: 'plan', type: 'custom', title: 'Buy milk' }),
      NOW,
    );

    expect(activity.objectKind).toBe('plan');
    expect(activity.type).toBe('custom');
  });

  /**
   * The same title through two explicit targets lands as two different objects. This is the
   * explicit-intent gate: nothing about the words chose either one
   * (`CLAUDE.md` rule 2, `definition-of-done.md` §3.1).
   */
  it('follows the caller’s choice rather than the words, for one identical title', async () => {
    const asTask = await createActivity(USER, task({ title: 'Dinner with Sam' }), NOW);
    const asPlan = await createActivity(
      USER,
      task({ objectKind: 'plan', type: 'outing', title: 'Dinner with Sam' }),
      NOW,
    );

    expect(asTask.activity.objectKind).toBe('task');
    expect(asTask.activity.type).toBe('task');
    expect(asPlan.activity.objectKind).toBe('plan');
    expect(asPlan.activity.type).toBe('outing');
  });

  it('derives the server-owned fields and takes none of them from the client', async () => {
    const { activity } = await createActivity(USER, task(), NOW);

    expect(activity).toMatchObject({
      ownerId: USER,
      status: 'saved',
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    });
  });

  it('is scheduled, with instants, when a date and time are given', async () => {
    const { activity } = await createActivity(
      USER,
      task({
        schedule: { date: '2026-08-09', time: '19:30', timezone: 'America/New_York' },
      }),
      NOW,
    );

    expect(activity.status).toBe('scheduled');
    expect(activity.schedule?.scheduledAtUtc).toBe('2026-08-09T23:30:00.000Z');
  });

  /** Rule 4: `private` at birth, and no argument to this function can change it. */
  it('starts private even for a plan', async () => {
    const { activity } = await createActivity(
      USER,
      task({ objectKind: 'plan', type: 'event' }),
      NOW,
    );

    expect(activity.visibility).toBe('private');
  });

  it('defaults details to the empty variant for the chosen type', async () => {
    const { activity } = await createActivity(
      USER,
      task({ objectKind: 'plan', type: 'meal' }),
      NOW,
    );

    expect(activity.details).toEqual({ kind: 'meal' });
  });

  it('omits an absent optional rather than storing it undefined', async () => {
    const { activity } = await createActivity(USER, task(), NOW);

    expect(activity).not.toHaveProperty('notes');
    expect(activity).not.toHaveProperty('schedule');
    expect(activity).not.toHaveProperty('recurrence');
  });

  /**
   * The other side of every optional. Each field is carried by its own ternary, so a field
   * dropped from the copy would be invisible until somebody noticed their notes had vanished
   * — this asserts they all arrive together.
   */
  it('carries every optional the input supplied', async () => {
    const { activity } = await createActivity(
      USER,
      task({
        objectKind: 'plan',
        type: 'meal',
        notes: 'Semi-skimmed',
        schedule: { date: '2026-08-09', time: '19:30', timezone: 'America/New_York' },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'weekly', effectiveFrom: '2026-08-01' }],
        },
        location: { label: 'Home' },
        sourceUrl: 'https://example.com/recipe',
        details: { kind: 'meal', mealSlot: 'dinner' },
      }),
      NOW,
    );

    expect(activity).toMatchObject({
      notes: 'Semi-skimmed',
      location: { label: 'Home' },
      sourceUrl: 'https://example.com/recipe',
      details: { kind: 'meal', mealSlot: 'dinner' },
    });
    expect(activity.recurrence?.mode).toBe('fixed');
    expect(activity.schedule?.time).toBe('19:30');
  });

  /** An all-day schedule stores its date and zone and derives no instant. */
  it('stores a schedule with no time, and derives no instant for it', async () => {
    const { activity } = await createActivity(
      USER,
      task({ schedule: { date: '2026-08-09', timezone: 'America/New_York' } }),
      NOW,
    );

    expect(activity.schedule).toEqual({
      date: '2026-08-09',
      timezone: 'America/New_York',
    });
    expect(activity.status).toBe('scheduled');
  });

  /**
   * Sharing is Phase 6. The field is accepted by the schema so the contract is stable, and
   * the service refuses it — **it is not silently dropped**, which would save a plan the user
   * believes they shared (P1-11).
   */
  it('rejects participants rather than dropping them', async () => {
    await expect(
      createActivity(
        USER,
        task({
          objectKind: 'plan',
          type: 'outing',
          participants: [{ displayName: 'Sam' }],
        }),
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Sharing is coming soon.',
    });

    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  it('accepts an empty participants array, which asks for nothing', async () => {
    const { activity } = await createActivity(
      USER,
      task({ objectKind: 'plan', type: 'outing', participants: [] }),
      NOW,
    );

    expect(activity.visibility).toBe('private');
  });
});

describe('reminders at creation', () => {
  it('writes them for the creator alone', async () => {
    const { reminders } = await createActivity(
      USER,
      task({ reminders: [{ offsetMinutes: -15 }] }),
      NOW,
    );

    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      userId: USER,
      offsetMinutes: -15,
      channel: 'push',
    });
  });

  it('passes them to the repository so they land in the same transaction', async () => {
    await createActivity(USER, task({ reminders: [{ offsetMinutes: -15 }] }), NOW);

    expect(written()?.[2]?.reminders).toEqual([
      { reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X2', offsetMinutes: -15 },
    ]);
  });

  it('writes none when none were asked for', async () => {
    const { reminders } = await createActivity(USER, task(), NOW);

    expect(reminders).toEqual([]);
  });
});

/** Rule 5. Two levels: a plan, and its prep tasks (`plans-and-lists.md` §3). */
describe('the nesting cap', () => {
  const parent = (overrides: Partial<Activity> = {}): Activity =>
    ({
      activityId: PLAN,
      ownerId: USER,
      status: 'saved',
      objectKind: 'plan',
      type: 'outing',
      title: 'Trip',
      details: { kind: 'outing' },
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
      ...overrides,
    }) as Activity;

  it('allows a prep task under a plan', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(parent());

    const { activity } = await createActivity(
      USER,
      task({ parentActivityId: PLAN }),
      NOW,
    );

    expect(activity.parentActivityId).toBe(PLAN);
  });

  it('refuses a third level, naming the field', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      parent({ parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XA' }),
    );

    await expect(
      createActivity(USER, task({ parentActivityId: PLAN }), NOW),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  /**
   * The cap check runs through `assertActivityAccess`, so guessing a parent id you have no
   * relationship to is `404` rather than a way to discover that it exists.
   */
  it('refuses a parent belonging to a stranger, as not_found', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      parent({ ownerId: 'usr_someone_else' }),
    );

    await expect(
      createActivity(USER, task({ parentActivityId: PLAN }), NOW),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a parent that does not exist', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(undefined);

    await expect(
      createActivity(USER, task({ parentActivityId: PLAN }), NOW),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

/**
 * Rule 6, and the assertion that matters most in this file.
 *
 * `REM#` rows for **every** participant live in the partition the single Query reads, so a
 * projection that returned what it read would hand one user another user's reminders — a leak
 * nobody would ever notice, because you cannot see what is missing from your own response
 * (`security-privacy.md` §1 row 15, ADR-047).
 */
describe('projectDetail', () => {
  const meta: StoredItem = {
    pk: `ACT#${PLAN}`,
    sk: 'META',
    entity: 'Activity',
    activityId: PLAN,
    ownerId: 'usr_a',
    status: 'saved',
    objectKind: 'plan',
    type: 'outing',
    title: 'Dinner',
    details: { kind: 'outing' },
    participantCount: 2,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'shared',
    icsSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  };

  /** Real `rem_` ULIDs, so the projection can be parsed by the shared schema below. */
  const REMINDER_OF = {
    usr_a: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
    usr_b: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1BB',
  } as const;

  const reminderOf = (
    userId: keyof typeof REMINDER_OF | string,
    offsetMinutes: number,
  ): StoredItem => ({
    pk: `ACT#${PLAN}`,
    sk: `REM#${userId}#${REMINDER_OF[userId as keyof typeof REMINDER_OF]}`,
    entity: 'Reminder',
    reminderId: REMINDER_OF[userId as keyof typeof REMINDER_OF],
    activityId: PLAN,
    userId,
    offsetMinutes,
    channel: 'push',
    schemaVersion: 1,
  });

  const partition = [meta, reminderOf('usr_a', -15), reminderOf('usr_b', -90)];

  it('returns the caller’s own reminder', () => {
    const detail = projectDetail(partition, 'usr_a');

    expect(detail.reminders).toHaveLength(1);
    expect(detail.reminders[0]).toMatchObject({ userId: 'usr_a', offsetMinutes: -15 });
  });

  /**
   * **No trace** — not the offset, not the id, not a count. Serialised and searched as a
   * string, because a leak that survives this is a leak through a field nobody thought to
   * assert on individually.
   */
  it('leaves no trace of the other participant’s reminder', () => {
    const serialised = JSON.stringify(projectDetail(partition, 'usr_a'));

    expect(serialised).not.toContain('usr_b');
    expect(serialised).not.toContain('-90');
    expect(serialised).not.toContain(REMINDER_OF.usr_b);
  });

  it('is symmetric — the other participant sees only theirs', () => {
    const detail = projectDetail(partition, 'usr_b');

    expect(detail.reminders).toHaveLength(1);
    expect(detail.reminders[0]?.userId).toBe('usr_b');
    expect(JSON.stringify(detail)).not.toContain(REMINDER_OF.usr_a);
  });

  /** A participant with no reminder of their own sees an empty array, not everybody's. */
  it('returns nothing for a participant who set none', () => {
    expect(projectDetail(partition, 'usr_c').reminders).toEqual([]);
  });

  it('never leaks the storage attributes', () => {
    const detail = projectDetail(partition, 'usr_a');

    expect(detail.activity).not.toHaveProperty('pk');
    expect(detail.activity).not.toHaveProperty('sk');
    expect(detail.activity).not.toHaveProperty('entity');
    expect(detail.reminders[0]).not.toHaveProperty('pk');
    expect(detail.reminders[0]).not.toHaveProperty('sk');
  });

  it('returns a body the shared detail schema accepts', async () => {
    const { activityDetail } = await import('@od/shared/schemas');

    expect(activityDetail.safeParse(projectDetail(partition, 'usr_a')).success).toBe(
      true,
    );
  });

  it('throws not_found when the partition has no META row', () => {
    expect(() => projectDetail([reminderOf('usr_a', -15)], 'usr_a')).toThrowError(
      /Activity not found/,
    );
  });

  /**
   * **The other half of the allow-list.** Every field is copied by its own line, so the risk
   * runs both ways: a storage attribute leaking out (asserted above) and a domain field
   * silently failing to come out. A user whose notes stopped appearing after an unrelated
   * refactor would report it as data loss.
   */
  it('projects every optional field the stored row carries', () => {
    const full: StoredItem = {
      ...meta,
      notes: 'Semi-skimmed',
      schedule: {
        date: '2026-08-09',
        time: '19:30',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-08-09T23:30:00.000Z',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekly', effectiveFrom: '2026-08-01' }],
      },
      location: { label: 'Home' },
      parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
      listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XC',
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD',
      sourceUrl: 'https://example.com',
      primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1XE',
      completedAt: '2026-08-10T00:00:00.000Z',
      outcome: 'attended',
    };

    const { activity } = projectDetail([full], 'usr_a');

    expect(activity).toMatchObject({
      notes: 'Semi-skimmed',
      location: { label: 'Home' },
      parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
      listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XC',
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD',
      sourceUrl: 'https://example.com',
      primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1XE',
      completedAt: '2026-08-10T00:00:00.000Z',
      outcome: 'attended',
    });
    expect(activity.schedule?.scheduledAtUtc).toBe('2026-08-09T23:30:00.000Z');
    expect(activity.recurrence?.mode).toBe('fixed');
  });

  /** …and omits each of them when the stored row has none, rather than emitting undefined. */
  it('omits every optional the stored row lacks', () => {
    const { activity } = projectDetail(partition, 'usr_a');

    for (const field of [
      'notes',
      'schedule',
      'recurrence',
      'location',
      'parentActivityId',
      'listItemId',
      'listId',
      'sourceUrl',
      'primaryAttachmentId',
      'completedAt',
      'outcome',
    ]) {
      expect(activity).not.toHaveProperty(field);
    }
  });
});

/** `toSchedule` is the one place the wall-clock fields and the derived instants converge. */
describe('toSchedule', () => {
  it('keeps the wall-clock fields and adds the instants', () => {
    expect(
      toSchedule({
        date: '2026-08-09',
        time: '19:30',
        endTime: '21:00',
        timezone: 'America/New_York',
      }),
    ).toEqual({
      date: '2026-08-09',
      time: '19:30',
      endTime: '21:00',
      timezone: 'America/New_York',
      scheduledAtUtc: '2026-08-09T23:30:00.000Z',
      endAtUtc: '2026-08-10T01:00:00.000Z',
    });
  });

  /**
   * An explicit `undefined` from the client is **omitted**, not stored. DynamoDB would keep a
   * null attribute, and every later reader would have to tell "no time" from "a null time".
   */
  it('omits an explicitly undefined optional rather than storing it', () => {
    expect(
      toSchedule({
        date: '2026-08-09',
        time: undefined,
        endTime: undefined,
        timezone: 'UTC',
      }),
    ).toEqual({ date: '2026-08-09', timezone: 'UTC' });
  });
});
