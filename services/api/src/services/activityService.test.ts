import type { CreateActivityInput } from '@od/shared/schemas';
import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import type { PrepTaskPointer } from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import {
  convertRecurrence,
  createActivity,
  deriveScheduleInstants,
  deriveStatus,
  getPrepTasks,
  patchActivity,
  projectChildren,
  projectDetail,
  removeActivity,
  sourceListIdsOf,
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
  patchActivity: vi.fn(() => Promise.resolve()),
  newActivityId: vi.fn(() => 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
  newReminderId: vi.fn(() => 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X2'),
  getActivityMeta: vi.fn(),
  getActivityPartition: vi.fn(),
  getActivityPartitionStrong: vi.fn(),
  listParticipants: vi.fn(() => Promise.resolve([])),
  listPrepTaskPointers: vi.fn(() => Promise.resolve([])),
  deleteActivity: vi.fn(() => Promise.resolve()),
  markActivityDeleting: vi.fn(() => Promise.resolve()),
  detachChildFromParent: vi.fn(() => Promise.resolve()),
  StaleViewerLinkError: class extends Error {},
  ParentUnavailableError: class extends Error {},
  ActivityIdUnavailableError: class extends Error {},
  PendingAttachmentsUnavailableError: class extends Error {},
  CoverAttachmentUnavailableError: class extends Error {},
}));

vi.mock('../repositories/listRepository.js', () => ({
  findViewerLinksTo: vi.fn(() => Promise.resolve([])),
}));

const attachmentCleanup = vi.hoisted(() => ({
  stage: vi.fn(() => Promise.resolve()),
  drain: vi.fn(() => Promise.resolve()),
}));

vi.mock('../repositories/attachmentRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/attachmentRepository.js')
  >('../repositories/attachmentRepository.js');
  return { ...actual, stageActivityAttachmentDeletion: attachmentCleanup.stage };
});

vi.mock('./attachmentService.js', async () => {
  const actual = await vi.importActual<typeof import('./attachmentService.js')>(
    './attachmentService.js',
  );
  return { ...actual, drainActivityAttachmentDeletions: attachmentCleanup.drain };
});

const repository = await import('../repositories/activityRepository.js');
const listRepository = await import('../repositories/listRepository.js');

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
  vi.mocked(repository.getActivityPartition).mockReset();
  vi.mocked(repository.getActivityPartitionStrong).mockReset();
  vi.mocked(repository.listParticipants).mockReset();
  vi.mocked(repository.listParticipants).mockResolvedValue([]);
  vi.mocked(repository.deleteActivity).mockReset();
  vi.mocked(repository.deleteActivity).mockResolvedValue(undefined);
  vi.mocked(repository.markActivityDeleting).mockReset();
  vi.mocked(repository.markActivityDeleting).mockResolvedValue(undefined);
  vi.mocked(repository.detachChildFromParent).mockReset();
  vi.mocked(repository.detachChildFromParent).mockResolvedValue(undefined);
  vi.mocked(repository.listPrepTaskPointers).mockReset();
  vi.mocked(repository.listPrepTaskPointers).mockResolvedValue([]);
  vi.mocked(listRepository.findViewerLinksTo).mockReset();
  vi.mocked(listRepository.findViewerLinksTo).mockResolvedValue([]);
  attachmentCleanup.stage.mockReset();
  attachmentCleanup.stage.mockResolvedValue(undefined);
  attachmentCleanup.drain.mockReset();
  attachmentCleanup.drain.mockResolvedValue(undefined);
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
      task({ objectKind: 'plan', type: 'event', title: 'Dinner with Sam' }),
      NOW,
    );

    expect(asTask.activity.objectKind).toBe('task');
    expect(asTask.activity.type).toBe('task');
    expect(asPlan.activity.objectKind).toBe('plan');
    expect(asPlan.activity.type).toBe('event');
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
      lastActivityAt: NOW,
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
          segments: [{ freq: 'weekly', byWeekday: [1], effectiveFrom: '2026-08-01' }],
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
    expect(activity.recurrence?.segments).toEqual([
      {
        freq: 'weekly',
        byWeekday: [1],
        effectiveFrom: '2026-08-09',
        time: '19:30',
      },
    ]);
    expect(activity.schedule?.time).toBe('19:30');
  });

  it('rejects a two-segment create even when called without the route schema', async () => {
    await expect(
      createActivity(
        USER,
        task({
          schedule: { date: '2026-08-09', timezone: 'America/New_York' },
          recurrence: {
            mode: 'fixed',
            segments: [
              { freq: 'daily', effectiveFrom: '2026-08-09' },
              { freq: 'daily', effectiveFrom: '2026-08-10' },
            ],
          },
        }),
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'A new recurrence must contain exactly one segment.',
    });

    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  it('rejects recurrence without a schedule date at the service boundary', async () => {
    await expect(
      createActivity(
        USER,
        task({
          recurrence: {
            mode: 'fixed',
            segments: [{ freq: 'daily', effectiveFrom: '2026-08-09' }],
          },
        }),
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Repeat needs a scheduled date.',
    });

    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  it('normalises every one day to daily before storing it', async () => {
    const { activity } = await createActivity(
      USER,
      task({
        schedule: { date: '2026-08-09', timezone: 'America/New_York' },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'interval_days', interval: 1, effectiveFrom: '2099-01-01' }],
        },
      }),
      NOW,
    );

    expect(activity.recurrence?.segments[0]?.freq).toBe('daily');
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
          type: 'event',
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
      task({ objectKind: 'plan', type: 'event', participants: [] }),
      NOW,
    );

    expect(activity.visibility).toBe('private');
  });
});

describe('reminders at creation', () => {
  it('writes them for the creator alone', async () => {
    const { reminders } = await createActivity(
      USER,
      task({
        schedule: { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      }),
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
    await createActivity(
      USER,
      task({
        schedule: { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      }),
      NOW,
    );

    expect(written()?.[2]?.reminders).toEqual([
      { reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X2', offsetMinutes: -15 },
    ]);
  });

  it('writes none when none were asked for', async () => {
    const { reminders } = await createActivity(USER, task(), NOW);

    expect(reminders).toEqual([]);
  });

  it('rejects an internal caller that supplies a reminder without a date', async () => {
    await expect(
      createActivity(USER, task({ reminders: [{ offsetMinutes: 0 }] }), NOW),
    ).rejects.toMatchObject({ name: 'ZodError' });
    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  it('enforces the timed versus date-only split at the service boundary', async () => {
    await expect(
      createActivity(
        USER,
        task({
          schedule: { date: '2026-08-12', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -15 }],
        }),
        NOW,
      ),
    ).rejects.toMatchObject({ name: 'ZodError' });

    await expect(
      createActivity(
        USER,
        task({
          schedule: { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
          reminders: [{ offsetMinutes: -15 }],
        }),
        NOW,
      ),
    ).resolves.toMatchObject({ reminders: [{ offsetMinutes: -15 }] });
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
      type: 'event',
      title: 'Trip',
      details: { kind: 'event' },
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

describe('removeActivity replay recovery', () => {
  const meta = {
    pk: `ACT#${PLAN}`,
    sk: 'META',
    entity: 'Activity',
    activityId: PLAN,
    ownerId: USER,
    status: 'saved',
    objectKind: 'plan',
    type: 'custom',
    title: 'Trip',
    details: { kind: 'custom' },
    participantCount: 0,
    childCount: 1,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  } as StoredItem;

  const child = {
    activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
    ownerId: USER,
    status: 'saved',
    objectKind: 'task',
    type: 'task',
    title: 'Pack',
    details: { kind: 'task' },
    parentActivityId: PLAN,
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  } as Activity;

  it('stages and drains permanent attachment media before deleting Activity rows', async () => {
    const attachment = {
      pk: `ACT#${PLAN}`,
      sk: 'ATT#att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      entity: 'Attachment',
      attachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      activityId: PLAN,
      key: `u/${USER}/01J8XKQ2M4N5P6R7S8T9V0W1X2.jpg`,
      contentType: 'image/jpeg',
      byteSize: 2048,
      createdAt: NOW,
      quotaSlot: 3,
      schemaVersion: 1,
    } as StoredItem;
    vi.mocked(repository.getActivityMeta).mockResolvedValue(meta as never);
    vi.mocked(repository.getActivityPartitionStrong).mockResolvedValue([
      meta,
      attachment,
    ]);

    await removeActivity(USER, PLAN, NOW);

    expect(attachmentCleanup.stage).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        attachmentId: attachment.attachmentId,
        key: attachment.key,
        quotaSlot: 3,
      }),
      NOW,
    );
    expect(attachmentCleanup.drain).toHaveBeenCalledWith(USER, PLAN);
    expect(attachmentCleanup.drain.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(repository.deleteActivity).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('retries after child cleanup while META still authorises, then ends at not_found', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(meta as never)
      .mockResolvedValueOnce(child)
      .mockResolvedValueOnce(meta as never)
      .mockResolvedValueOnce(undefined);
    vi.mocked(repository.getActivityPartitionStrong)
      .mockResolvedValueOnce([
        meta,
        {
          pk: `ACT#${PLAN}`,
          sk: `SUB#${child.activityId}`,
          entity: 'ChildPointer',
          childActivityId: child.activityId,
          schemaVersion: 1,
        },
      ])
      .mockResolvedValueOnce([meta]);
    vi.mocked(repository.deleteActivity)
      .mockRejectedValueOnce(new Error('interrupted before META delete'))
      .mockResolvedValueOnce(undefined);

    await expect(removeActivity(USER, PLAN, NOW)).rejects.toThrow(
      'interrupted before META delete',
    );
    expect(repository.patchActivity).toHaveBeenCalledTimes(1);

    await expect(removeActivity(USER, PLAN, NOW)).resolves.toBe(PLAN);
    expect(repository.patchActivity).toHaveBeenCalledTimes(1);
    expect(repository.deleteActivity).toHaveBeenCalledTimes(2);

    await expect(removeActivity(USER, PLAN, NOW)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(repository.deleteActivity).toHaveBeenCalledTimes(2);
  });

  /**
   * The orphaning pass reads each child to clear its `parentActivityId`, and both things it
   * can learn from that read were being over-trusted.
   */
  describe('what the orphaning read is allowed to conclude', () => {
    const pointerRow = {
      pk: `ACT#${PLAN}`,
      sk: `SUB#${child.activityId}`,
      entity: 'ChildPointer',
      childActivityId: child.activityId,
      schemaVersion: 1,
    } as StoredItem;

    beforeEach(() => {
      vi.mocked(repository.patchActivity).mockClear();
      vi.mocked(repository.deleteActivity).mockReset();
      vi.mocked(repository.deleteActivity).mockResolvedValue(undefined);
      vi.mocked(repository.getActivityPartitionStrong).mockResolvedValue([
        meta,
        pointerRow,
      ]);
    });

    /**
     * The pointer and the child commit in **one** transaction, so a strong Query that sees
     * the pointer proves the child exists. Reading the child weakly and taking the miss as
     * "already gone" would skip the one write that could have repaired it, and the very next
     * step deletes the parent — leaving a task whose `parentActivityId` resolves to nothing.
     */
    it('reads the child strongly, so a replica miss cannot pass for absence', async () => {
      vi.mocked(repository.getActivityMeta)
        .mockResolvedValueOnce(meta as never)
        .mockResolvedValueOnce(child);

      await removeActivity(USER, PLAN, NOW);

      expect(repository.getActivityMeta).toHaveBeenCalledWith(child.activityId, {
        consistentRead: true,
      });
      expect(repository.patchActivity).toHaveBeenCalledTimes(1);
    });

    /**
     * A child re-parented onto another plan after the snapshot is **not** ours to release.
     * Clearing it would undo the move and strand the new parent's pointer and `childCount`
     * describing a child that no longer names it.
     */
    it('leaves a child that has since been re-parented elsewhere', async () => {
      vi.mocked(repository.getActivityMeta)
        .mockResolvedValueOnce(meta as never)
        .mockResolvedValueOnce({
          ...child,
          parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XZ',
        });

      await removeActivity(USER, PLAN, NOW);

      expect(repository.patchActivity).not.toHaveBeenCalled();
      expect(repository.deleteActivity).toHaveBeenCalledTimes(1);
    });
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
    type: 'event',
    title: 'Dinner',
    details: { kind: 'event' },
    participantCount: 2,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'shared',
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
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
  const detailTarget = { kind: 'activity', activityId: PLAN } as const;

  it('authors action capability for the caller instead of exposing owner inference', () => {
    expect(projectDetail(partition, 'usr_a', detailTarget).capabilities).toEqual({
      complete: true,
      skip: true,
      snooze: true,
    });
    expect(projectDetail(partition, 'usr_b', detailTarget).capabilities).toEqual({
      complete: false,
      skip: false,
      snooze: false,
    });
    expect(
      projectDetail(partition, 'usr_b', detailTarget, {
        complete: true,
        skip: true,
        snooze: true,
      }).capabilities,
    ).toEqual({ complete: true, skip: true, snooze: true });
  });

  it('returns the caller’s own reminder', () => {
    const detail = projectDetail(partition, 'usr_a', detailTarget);

    expect(detail.reminders).toHaveLength(1);
    expect(detail.reminders[0]).toMatchObject({ userId: 'usr_a', offsetMinutes: -15 });
  });

  /**
   * **No trace** — not the offset, not the id, not a count. Serialised and searched as a
   * string, because a leak that survives this is a leak through a field nobody thought to
   * assert on individually.
   */
  it('leaves no trace of the other participant’s reminder', () => {
    const serialised = JSON.stringify(projectDetail(partition, 'usr_a', detailTarget));

    expect(serialised).not.toContain('usr_b');
    expect(serialised).not.toContain('-90');
    expect(serialised).not.toContain(REMINDER_OF.usr_b);
  });

  it('is symmetric — the other participant sees only theirs', () => {
    const detail = projectDetail(partition, 'usr_b', detailTarget);

    expect(detail.reminders).toHaveLength(1);
    expect(detail.reminders[0]?.userId).toBe('usr_b');
    expect(JSON.stringify(detail)).not.toContain(REMINDER_OF.usr_a);
  });

  /** A participant with no reminder of their own sees an empty array, not everybody's. */
  it('returns nothing for a participant who set none', () => {
    expect(projectDetail(partition, 'usr_c', detailTarget).reminders).toEqual([]);
  });

  it('derives the real completed-occurrence count from the partition already read', () => {
    const occurrences: StoredItem[] = [
      {
        pk: `ACT#${PLAN}`,
        sk: 'OCC#2026-08-01',
        entity: 'Occurrence',
        status: 'completed',
      },
      {
        pk: `ACT#${PLAN}`,
        sk: 'OCC#2026-08-02',
        entity: 'Occurrence',
        status: 'skipped',
      },
      {
        pk: `ACT#${PLAN}`,
        sk: 'OCC#2026-08-03',
        entity: 'Occurrence',
        status: 'completed',
      },
    ];

    expect(
      projectDetail([...partition, ...occurrences], 'usr_a', detailTarget)
        .completedOccurrenceCount,
    ).toBe(2);
  });

  it('projects an explicitly targeted stored occurrence from a legacy partition fixture', () => {
    const date = '2026-08-09';
    const recurring: StoredItem = {
      ...meta,
      status: 'scheduled',
      schedule: {
        date,
        time: '19:30',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-08-09T23:30:00.000Z',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: date }],
      },
    };
    const completed: StoredItem = {
      pk: `ACT#${PLAN}`,
      sk: `OCC#${date}`,
      entity: 'Occurrence',
      activityId: PLAN,
      date,
      status: 'completed',
      completedAt: '2026-08-09T23:45:00.000Z',
      schemaVersion: 1,
    };

    expect(
      projectDetail([recurring, completed], 'usr_a', {
        kind: 'occurrence',
        activityId: PLAN,
        date,
      }).occurrence,
    ).toMatchObject({
      nominalDate: date,
      date,
      time: '19:30',
      status: 'completed_occurrence',
      completedAt: '2026-08-09T23:45:00.000Z',
    });
  });

  it('never leaks the storage attributes', () => {
    const detail = projectDetail(partition, 'usr_a', detailTarget);

    expect(detail.activity).not.toHaveProperty('pk');
    expect(detail.activity).not.toHaveProperty('sk');
    expect(detail.activity).not.toHaveProperty('entity');
    expect(detail.reminders[0]).not.toHaveProperty('pk');
    expect(detail.reminders[0]).not.toHaveProperty('sk');
  });

  it('returns a body the shared detail schema accepts', async () => {
    const { activityDetail } = await import('@od/shared/schemas');

    expect(
      activityDetail.safeParse(projectDetail(partition, 'usr_a', detailTarget)).success,
    ).toBe(true);
  });

  it('throws not_found when the partition has no META row', () => {
    expect(() =>
      projectDetail([reminderOf('usr_a', -15)], 'usr_a', detailTarget),
    ).toThrowError(/Activity not found/);
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
        endTime: '21:00',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-08-09T23:30:00.000Z',
        endAtUtc: '2026-08-10T01:00:00.000Z',
      },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekly', byWeekday: [0], effectiveFrom: '2026-08-01' }],
      },
      location: {
        label: 'Home',
        address: '1 Main Street',
        lat: 40.7128,
        lng: -74.006,
        mapUrl: 'https://example.com/map',
      },
      details: {
        kind: 'event',
        description: 'Doors at seven',
        priceCents: 2500,
        currency: 'USD',
        ticketUrl: 'https://example.com/tickets',
        organiser: 'Neighbourhood Hall',
        reservation: {
          name: 'Alex',
          time: '19:00',
          partySize: 2,
          reference: 'TABLE-7',
        },
      },
      parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
      listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XC',
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD',
      sourceUrl: 'https://example.com',
      primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1XE',
      completedAt: '2026-08-10T00:00:00.000Z',
      outcome: 'attended',
    };

    const { activity } = projectDetail([full], 'usr_a', detailTarget);

    expect(activity).toMatchObject({
      notes: 'Semi-skimmed',
      location: { label: 'Home' },
      parentActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
      sourceUrl: 'https://example.com',
      primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1XE',
      completedAt: '2026-08-10T00:00:00.000Z',
      outcome: 'attended',
    });
    expect(activity.schedule?.scheduledAtUtc).toBe('2026-08-09T23:30:00.000Z');
    expect(activity.recurrence?.mode).toBe('fixed');
  });

  it.each([
    [{ objectKind: 'task', type: 'task', details: { kind: 'task' } }],
    [{ objectKind: 'plan', type: 'meal', details: { kind: 'meal' } }],
    [
      {
        objectKind: 'plan',
        type: 'meal',
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [
            {
              ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1MA',
              name: 'Tomatoes',
              quantity: '2',
              addedToListId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1MB',
            },
          ],
          recipeUrl: 'https://example.com/recipe',
        },
      },
    ],
    [
      {
        objectKind: 'plan',
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Arrival' },
      },
    ],
    [
      {
        objectKind: 'plan',
        type: 'watch',
        details: {
          kind: 'watch',
          mediaTitle: 'Severance',
          mediaKind: 'show',
          season: 2,
          episode: 3,
          episodeTitle: 'Who Is Alive?',
          service: 'Apple TV+',
        },
      },
    ],
    [{ objectKind: 'plan', type: 'custom', details: { kind: 'custom' } }],
    [
      {
        objectKind: 'plan',
        type: 'custom',
        details: {
          kind: 'custom',
          shortcutId: 'sct_01J8XKQ2M4N5P6R7S8T9V0W1MC',
        },
      },
    ],
  ])(
    'projects schema-owned detail variants without explicit undefined keys',
    (variant) => {
      const { activity } = projectDetail(
        [{ ...meta, ...variant }],
        'usr_a',
        detailTarget,
      );

      expect(activity.details).toEqual(variant.details);
      expect(Object.values(activity.details)).not.toContain(undefined);
    },
  );

  /**
   * **The two exceptions to "project every field", and the reason is the contract.**
   *
   * `api-contract.md` §2.3 keeps `listId` and `listItemId` off `Activity`. The gated named
   * reverse link is optional envelope `sourceList`, hydrated only after list access. This
   * projection helper does not hydrate that field; it still must not leak the ids on
   * `Activity` or under another name.
   */
  it('omits listId and listItemId on Activity even when the stored row carries them', () => {
    const withLinks: StoredItem = {
      ...meta,
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD',
      listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XC',
    };

    const detail = projectDetail([withLinks], 'usr_a', detailTarget);

    expect(detail.activity).not.toHaveProperty('listId');
    expect(detail.activity).not.toHaveProperty('listItemId');
    expect(detail).not.toHaveProperty('sourceList');
    // Serialised too, so a field added under another name is caught as well.
    expect(JSON.stringify(detail.activity)).not.toContain('lst_');
    expect(JSON.stringify(detail.activity)).not.toContain('itm_');
  });

  /** …and omits each of them when the stored row has none, rather than emitting undefined. */
  it('omits every optional the stored row lacks', () => {
    const { activity } = projectDetail(partition, 'usr_a', detailTarget);

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

/** The two P3-37 collections the one detail read composes from the partition it holds. */
describe('projectChildren and sourceListIdsOf', () => {
  const CHILD_A = 'act_01J8XKQ2M4N5P6R7S8T9V0W1CA';
  const CHILD_B = 'act_01J8XKQ2M4N5P6R7S8T9V0W1CB';

  const pointer = (
    childActivityId: string,
    rank: string,
    status = 'scheduled',
    restoredStatus = 'scheduled',
  ): StoredItem => ({
    pk: `ACT#${PLAN}`,
    sk: `SUB#${childActivityId}`,
    entity: 'ChildPointer',
    childActivityId,
    title: `Child ${childActivityId.slice(-2)}`,
    status,
    restoredStatus,
    rank,
    isRecurring: false,
    schemaVersion: 1,
  });

  it('orders children by rank, the ordering P3-49 depends on, not by id', () => {
    const children = projectChildren([
      pointer(CHILD_A, 'b'),
      pointer(CHILD_B, 'a', 'completed'),
    ]);
    expect(children.map((child) => child.activityId)).toEqual([CHILD_B, CHILD_A]);
    expect(children[0]).toEqual({
      activityId: CHILD_B,
      title: `Child ${CHILD_B.slice(-2)}`,
      status: 'completed',
      restoredStatus: 'scheduled',
      isRecurring: false,
    });
  });

  it('degrades a malformed pointer to absence rather than failing the read', () => {
    const malformed: StoredItem = {
      pk: `ACT#${PLAN}`,
      sk: `SUB#${CHILD_A}`,
      entity: 'ChildPointer',
      childActivityId: CHILD_A,
      status: 'nonsense',
      rank: 'a',
      schemaVersion: 1,
    };
    expect(projectChildren([malformed, pointer(CHILD_B, 'b')])).toHaveLength(1);
  });

  it('reads SOURCE_LIST# ids in stored order and nothing else', () => {
    const source = (listId: string): StoredItem => ({
      pk: `ACT#${PLAN}`,
      sk: `SOURCE_LIST#${listId}`,
      entity: 'SourceList',
      listId,
      schemaVersion: 1,
    });
    expect(
      sourceListIdsOf([
        source('lst_01J8XKQ2M4N5P6R7S8T9V0W1LA'),
        pointer(CHILD_A, 'a'),
        source('lst_01J8XKQ2M4N5P6R7S8T9V0W1LB'),
      ]),
    ).toEqual(['lst_01J8XKQ2M4N5P6R7S8T9V0W1LA', 'lst_01J8XKQ2M4N5P6R7S8T9V0W1LB']);
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

/**
 * `patchActivity` (P1-13). The repository is mocked, so what these assert is the service's
 * own decisions: which value wins when a conversion and an explicit field collide, and the
 * log line that is the only surviving copy of a dropped payload.
 */
describe('patchActivity', () => {
  const VERSION = '2026-08-09T00:00:00.000Z';
  const LATER = '2026-08-09T12:00:00.000Z';

  const stored = (overrides: Record<string, unknown> = {}): StoredItem => ({
    pk: `ACT#${PLAN}`,
    sk: 'META',
    entity: 'Activity',
    activityId: PLAN,
    ownerId: USER,
    status: 'saved',
    objectKind: 'plan',
    type: 'event',
    title: 'The Barbican',
    details: { kind: 'event', description: 'Doors at seven', organiser: 'The Barbican' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-08-05T00:00:00.000Z',
    updatedAt: VERSION,
    schemaVersion: 1,
    ...overrides,
  });

  const firstSegment = {
    freq: 'daily' as const,
    effectiveFrom: '2026-08-01',
    time: '09:00',
  };

  const recurring = (overrides: Record<string, unknown> = {}): StoredItem =>
    stored({
      status: 'scheduled',
      schedule: {
        date: '2026-08-01',
        time: '09:00',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-08-01T13:00:00.000Z',
      },
      recurrence: { mode: 'fixed', segments: [firstSegment] },
      ...overrides,
    });

  /**
   * `mockClear` as well as `mockResolvedValue`: the outer `beforeEach` clears the *create*
   * mock and not this one, so without it `mock.calls[0]` is the first call recorded anywhere
   * in this block — an earlier test's — and an assertion about "the call this test made"
   * quietly inspects somebody else's.
   */
  const seed = (row: StoredItem = stored()) => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(row as never);
    vi.mocked(repository.listParticipants).mockResolvedValue([]);
    vi.mocked(repository.patchActivity).mockClear();
    vi.mocked(repository.patchActivity).mockResolvedValue(undefined);
  };

  /**
   * The Plan → Task conversion losing its pinned `childCount`, which is only reachable as a
   * race: the 409 guard refuses an already-populated plan from the row it reads, so the
   * transaction condition can only fail when a child attached *after* that read. Mocked
   * rather than raced, because the window cannot be forced against a real table.
   */
  describe('when the pinned childCount loses', () => {
    it('names the prep-task blocker rather than handing back the caller’s own token', async () => {
      // Read: an empty plan, so the 409 guard lets the conversion through.
      vi.mocked(repository.getActivityMeta).mockResolvedValueOnce(stored() as never);
      vi.mocked(repository.listParticipants).mockResolvedValue([]);
      // The write is cancelled, and the re-read shows why: a child arrived, and `updatedAt`
      // did not move — because the counter is an `ADD` that deliberately leaves it alone.
      vi.mocked(repository.patchActivity).mockRejectedValueOnce(
        new AppError('conflict', 'cancelled'),
      );
      vi.mocked(repository.getActivityMeta).mockResolvedValueOnce(
        stored({ childCount: 1 }) as never,
      );

      await expect(
        patchActivity(USER, PLAN, { objectKind: 'task', type: 'task' }, VERSION, LATER),
      ).rejects.toMatchObject({
        code: 'conflict',
        message: 'Remove 1 prep task before changing this to a Task.',
      });
    });

    /** A version that genuinely moved is still an ordinary stale edit, reported as one. */
    it('still reports a real stale edit when the version moved', async () => {
      vi.mocked(repository.getActivityMeta).mockResolvedValueOnce(stored() as never);
      vi.mocked(repository.listParticipants).mockResolvedValue([]);
      vi.mocked(repository.patchActivity).mockRejectedValueOnce(
        new AppError('conflict', 'cancelled'),
      );
      vi.mocked(repository.getActivityMeta).mockResolvedValueOnce(
        stored({ updatedAt: LATER }) as never,
      );

      await expect(
        patchActivity(USER, PLAN, { objectKind: 'task', type: 'task' }, VERSION, LATER),
      ).rejects.toMatchObject({
        code: 'conflict',
        details: [{ path: 'updatedAt', message: LATER }],
      });
    });
  });

  /**
   * §6.3 point 7: the dropped payload is logged so a support request can recover it from the
   * logs inside the retention window. It is not restorable through the UI, so this line is
   * the only copy — and it carries the **`details` object itself**, not a summary.
   */
  it('logs the dropped details payload under a greppable event code', async () => {
    seed();
    const info = vi.fn();

    await patchActivity(
      USER,
      PLAN,
      { objectKind: 'task', type: 'task' },
      VERSION,
      LATER,
      // biome-ignore lint/suspicious/noExplicitAny: a logger stub with one method.
      { info } as any,
    );

    expect(info.mock.calls[0]?.[0]).toMatchObject({
      event: 'activity_kind_changed',
      activityId: PLAN,
      from: { objectKind: 'plan', type: 'event' },
      to: { objectKind: 'task', type: 'task' },
      droppedDetails: { kind: 'event', organiser: 'The Barbican' },
    });
  });

  /** Nothing was lost, so there is nothing to recover and no line to write. */
  it('logs nothing when the change drops no field', async () => {
    seed(stored({ type: 'custom', details: { kind: 'custom' } }));
    const info = vi.fn();

    await patchActivity(
      USER,
      PLAN,
      { objectKind: 'task', type: 'task' },
      VERSION,
      LATER,
      // biome-ignore lint/suspicious/noExplicitAny: a logger stub with one method.
      { info } as any,
    );

    expect(info).not.toHaveBeenCalled();
  });

  it('atomically clears the Plan-specific link and provenance on Plan → Task', async () => {
    const listId = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';
    const itemId = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X5';
    const viewerLink = {
      listId,
      itemId,
      viewerUserId: USER,
      activityId: PLAN,
      linkedAt: VERSION,
    };
    seed(stored({ listId, listItemId: itemId }));
    vi.mocked(listRepository.findViewerLinksTo).mockResolvedValue([viewerLink]);

    await patchActivity(USER, PLAN, { objectKind: 'task', type: 'task' }, VERSION, LATER);

    expect(listRepository.findViewerLinksTo).toHaveBeenCalledWith(listId, itemId, PLAN);
    const [, written, , options] =
      vi.mocked(repository.patchActivity).mock.calls[0] ?? [];
    expect(written).not.toHaveProperty('listId');
    expect(written).not.toHaveProperty('listItemId');
    expect(options?.clearViewerLinks).toEqual([viewerLink]);
  });

  it('retains the link and provenance when a Plan is cancelled', async () => {
    const listId = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';
    const itemId = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X5';
    seed(stored({ listId, listItemId: itemId }));

    await patchActivity(USER, PLAN, { status: 'cancelled' }, VERSION, LATER);

    const written = vi.mocked(repository.patchActivity).mock.calls[0]?.[1];
    expect(written).toMatchObject({ status: 'cancelled', listId, listItemId: itemId });
    expect(listRepository.findViewerLinksTo).not.toHaveBeenCalled();
  });

  /**
   * A conversion can produce notes of its own — an event's description appended. When the
   * request also names `notes`, the request wins: the client has already run the same mapping
   * to render the confirmation, so its value is the post-change text the user approved, and
   * appending again would duplicate what they are looking at.
   */
  it('lets an explicit notes value beat the conversion’s appended one', async () => {
    seed();

    const result = await patchActivity(
      USER,
      PLAN,
      { objectKind: 'plan', type: 'custom', notes: 'Doors at seven' },
      VERSION,
      LATER,
    );

    expect(result.notes).toBe('Doors at seven');
  });

  it('uses the conversion’s notes when the request names none', async () => {
    seed();

    const result = await patchActivity(
      USER,
      PLAN,
      { objectKind: 'plan', type: 'custom' },
      VERSION,
      LATER,
    );

    expect(result.notes).toBe('Doors at seven');
  });

  it('writes conditionally on the version the caller sent', async () => {
    seed();

    await patchActivity(USER, PLAN, { title: 'Renamed' }, VERSION, LATER);

    expect(vi.mocked(repository.patchActivity).mock.calls[0]?.[2]).toBe(VERSION);
  });

  it('moves updatedAt on an edit and leaves lastActivityAt unchanged', async () => {
    seed();

    const result = await patchActivity(USER, PLAN, { title: 'Renamed' }, VERSION, LATER);

    expect(result.updatedAt).toBe(LATER);
    expect(result.lastActivityAt).toBe('2026-08-05T00:00:00.000Z');
  });

  it('hands the repository the row it read, so a bucket move can rewrite the index', async () => {
    const row = stored();
    seed(row);

    await patchActivity(USER, PLAN, { title: 'Renamed' }, VERSION, LATER);

    expect(vi.mocked(repository.patchActivity).mock.calls[0]?.[3]?.previous).toBe(row);
  });

  /** The response is projected; the write is not. See the note in `patchActivity`. */
  it('returns no storage attributes but writes them through', async () => {
    seed();

    const result = await patchActivity(USER, PLAN, { title: 'Renamed' }, VERSION, LATER);

    expect(result).not.toHaveProperty('pk');
    expect(result).not.toHaveProperty('entity');
    expect(vi.mocked(repository.patchActivity).mock.calls[0]?.[1]).toHaveProperty('pk');
  });

  it('adds a first recurrence segment anchored to the stored schedule date', async () => {
    seed(
      stored({
        status: 'scheduled',
        schedule: {
          date: '2026-08-08',
          time: '18:30',
          endTime: '20:00',
          timezone: 'America/New_York',
        },
      }),
    );

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'weekly', byWeekday: [6], effectiveFrom: '2099-01-01' }],
        },
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence?.segments).toEqual([
      {
        freq: 'weekly',
        byWeekday: [6],
        effectiveFrom: '2026-08-08',
        time: '18:30',
        endTime: '20:00',
      },
    ]);
  });

  it('appends one segment at a valid emitted editedFromDate', async () => {
    seed(recurring());

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            firstSegment,
            { freq: 'weekly', byWeekday: [1, 3, 5], effectiveFrom: '2099-01-01' },
          ],
        },
        editedFromDate: '2026-08-10',
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence?.segments[0]).toEqual(firstSegment);
    expect(result.recurrence?.segments[1]).toEqual({
      freq: 'weekly',
      byWeekday: [1, 3, 5],
      effectiveFrom: '2026-08-10',
      time: '09:00',
    });
  });

  it('replaces an untouched active segment that starts today and guards its occurrence row', async () => {
    const todaySegment = {
      freq: 'daily' as const,
      effectiveFrom: '2026-08-09',
      time: '09:00',
    };
    seed(
      recurring({
        schedule: {
          date: '2026-08-09',
          time: '09:00',
          timezone: 'America/New_York',
        },
        recurrence: { mode: 'fixed', segments: [todaySegment] },
      }),
    );

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            {
              freq: 'weekly',
              interval: 1,
              byWeekday: [0],
              effectiveFrom: '2026-08-09',
            },
          ],
        },
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence?.segments).toEqual([
      {
        freq: 'weekly',
        interval: 1,
        byWeekday: [0],
        effectiveFrom: '2026-08-09',
        time: '09:00',
      },
    ]);
    expect(repository.patchActivity).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ recurrence: result.recurrence }),
      VERSION,
      expect.objectContaining({ requireMissingOccurrenceDate: '2026-08-09' }),
    );
  });

  it('mirrors an all-future segment time onto the active schedule without rewriting history', async () => {
    seed(recurring());

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [
            firstSegment,
            { freq: 'daily', effectiveFrom: '2099-01-01', time: '18:30' },
          ],
        },
        editedFromDate: '2026-08-10',
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence?.segments[0]).toEqual(firstSegment);
    expect(result.recurrence?.segments[1]).toEqual({
      freq: 'daily',
      effectiveFrom: '2026-08-10',
      time: '18:30',
    });
    expect(result.schedule).toEqual({
      date: '2026-08-01',
      time: '18:30',
      timezone: 'America/New_York',
      scheduledAtUtc: '2026-08-01T22:30:00.000Z',
    });
    expect(result.icsSequence).toBe(1);
  });

  it('rejects an editedFromDate the current active rule does not emit', async () => {
    const monday = {
      freq: 'weekly' as const,
      byWeekday: [1 as const],
      effectiveFrom: '2026-08-03',
      time: '09:00',
    };
    seed(
      recurring({
        schedule: {
          date: '2026-08-03',
          time: '09:00',
          timezone: 'America/New_York',
        },
        recurrence: { mode: 'fixed', segments: [monday] },
      }),
    );

    await expect(
      patchActivity(
        USER,
        PLAN,
        {
          recurrence: {
            mode: 'fixed',
            segments: [monday, { freq: 'daily', effectiveFrom: '2099-01-01' }],
          },
          editedFromDate: '2026-08-11',
        },
        VERSION,
        LATER,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('must be an occurrence'),
    });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('uses Activity-local today when an append has no editedFromDate', async () => {
    seed(recurring());

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [firstSegment, { freq: 'daily', effectiveFrom: '2099-01-01' }],
        },
      },
      VERSION,
      '2026-08-10T01:00:00.000Z',
    );

    expect(result.recurrence?.segments[1]?.effectiveFrom).toBe('2026-08-09');
  });

  it('ignores a conflicting client effectiveFrom on the appended segment', async () => {
    seed(recurring());

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [firstSegment, { freq: 'daily', effectiveFrom: '2099-12-31' }],
        },
        editedFromDate: '2026-08-12',
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence?.segments[1]?.effectiveFrom).toBe('2026-08-12');
  });

  it('allows an Ends-only edit without appending or rewriting history', async () => {
    seed(recurring());

    const result = await patchActivity(
      USER,
      PLAN,
      {
        recurrence: {
          mode: 'fixed',
          segments: [firstSegment],
          count: 12,
        },
      },
      VERSION,
      LATER,
    );

    expect(result.recurrence).toEqual({
      mode: 'fixed',
      segments: [firstSegment],
      count: 12,
    });
  });

  it.each([
    ['rewrites a previous segment', [{ ...firstSegment, freq: 'weekdays' as const }]],
    ['deletes previous history', []],
    [
      'adds two segments in one edit',
      [
        firstSegment,
        { freq: 'daily' as const, effectiveFrom: '2026-08-09' },
        { freq: 'daily' as const, effectiveFrom: '2026-08-10' },
      ],
    ],
  ])('rejects a recurrence patch that %s', async (_name, segments) => {
    seed(recurring());

    await expect(
      patchActivity(
        USER,
        PLAN,
        { recurrence: { mode: 'fixed', segments } },
        VERSION,
        LATER,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('append-only'),
    });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('rejects editedFromDate when no segment is appended', async () => {
    seed(recurring());

    await expect(
      patchActivity(
        USER,
        PLAN,
        {
          recurrence: { mode: 'fixed', segments: [firstSegment] },
          editedFromDate: '2026-08-10',
        },
        VERSION,
        LATER,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('rejects unscoped recurrence removal in favor of targeted conversion', async () => {
    seed(recurring());

    await expect(
      patchActivity(USER, PLAN, { recurrence: null }, VERSION, LATER),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('selected occurrence'),
    });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('rejects recurrence null as a PATCH no-op on a non-recurring activity', async () => {
    seed();

    await expect(
      patchActivity(USER, PLAN, { recurrence: null }, VERSION, LATER),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('rejects the append that would create a 21st segment with explaining copy', async () => {
    const segments = Array.from({ length: 20 }, (_, index) => ({
      freq: 'daily' as const,
      effectiveFrom: `2026-07-${String(index + 1).padStart(2, '0')}`,
      time: '09:00',
    }));
    seed(recurring({ recurrence: { mode: 'fixed', segments } }));

    await expect(
      patchActivity(
        USER,
        PLAN,
        {
          recurrence: {
            mode: 'fixed',
            segments: [...segments, { freq: 'daily', effectiveFrom: '2099-01-01' }],
          },
        },
        VERSION,
        '2026-08-10T12:00:00.000Z',
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: expect.stringContaining('start a new one'),
    });
  });

  it('409s a stale version before composing anything, and writes nothing', async () => {
    seed();

    await expect(
      patchActivity(USER, PLAN, { title: 'Renamed' }, 'stale', LATER),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  /**
   * A details-only PATCH never reaches `checkDetailsMatchType`: the schema runs that
   * refinement only when `type` is also present. Without a service guard, merge would write
   * a meal as a watch and GET would then 500 on parse.
   */
  describe('details-only kind', () => {
    const INGREDIENT_ID = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1MA';
    const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1MB';
    const KIND_MISMATCH = 'details.kind must be "meal" to match the activity type';

    const meal = () =>
      stored({
        objectKind: 'plan',
        type: 'meal',
        title: 'Tacos',
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [
            {
              ingredientId: INGREDIENT_ID,
              name: 'Tomatoes',
              quantity: '2',
              addedToListId: LIST_ID,
            },
          ],
        },
      });

    it('refuses a mismatched details-only patch, and writes nothing', async () => {
      seed(meal());

      await expect(
        patchActivity(
          USER,
          PLAN,
          { details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show' } },
          VERSION,
          LATER,
        ),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        message: KIND_MISMATCH,
        details: [{ path: 'details.kind', message: KIND_MISMATCH }],
      });

      expect(repository.patchActivity).not.toHaveBeenCalled();
    });

    it('keeps addedToListId when same-kind details replace ingredients', async () => {
      seed(meal());

      const result = await patchActivity(
        USER,
        PLAN,
        {
          details: {
            kind: 'meal',
            mealSlot: 'lunch',
            recipeUrl: 'https://example.com/recipe',
            ingredients: [
              {
                ingredientId: INGREDIENT_ID,
                name: 'Tomatoes',
                quantity: '3',
              },
            ],
          },
        },
        VERSION,
        LATER,
      );

      expect(result.details).toEqual({
        kind: 'meal',
        mealSlot: 'lunch',
        recipeUrl: 'https://example.com/recipe',
        ingredients: [
          {
            ingredientId: INGREDIENT_ID,
            name: 'Tomatoes',
            quantity: '3',
            addedToListId: LIST_ID,
          },
        ],
      });
      expect(repository.patchActivity).toHaveBeenCalledTimes(1);
    });

    /**
     * 2026-09-10: the meal sheet edits ingredient rows after creation. A details PATCH that
     * renames a kept row, drops another and adds a new one is accepted; the kept id keeps
     * its marker, the new id has none, and the removed row takes its marker with it.
     */
    it('accepts added and removed rows, keeping provenance only for kept ids', async () => {
      const KEPT_ID = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1MC';
      const NEW_ID = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1MD';
      seed(
        stored({
          objectKind: 'plan',
          type: 'meal',
          title: 'Tacos',
          details: {
            kind: 'meal',
            ingredients: [
              { ingredientId: INGREDIENT_ID, name: 'Tomatoes', addedToListId: LIST_ID },
              { ingredientId: KEPT_ID, name: 'Salsa', addedToListId: LIST_ID },
            ],
          },
        }),
      );

      const result = await patchActivity(
        USER,
        PLAN,
        {
          details: {
            kind: 'meal',
            ingredients: [
              { ingredientId: KEPT_ID, name: 'Hot salsa' },
              { ingredientId: NEW_ID, name: 'Limes', quantity: '3' },
            ],
          },
        },
        VERSION,
        LATER,
      );

      expect(result.details).toEqual({
        kind: 'meal',
        ingredients: [
          { ingredientId: KEPT_ID, name: 'Hot salsa', addedToListId: LIST_ID },
          { ingredientId: NEW_ID, name: 'Limes', quantity: '3' },
        ],
      });
      expect(repository.patchActivity).toHaveBeenCalledTimes(1);
    });

    it('clears every row when the details PATCH omits ingredients', async () => {
      seed(meal());

      const result = await patchActivity(
        USER,
        PLAN,
        { details: { kind: 'meal', mealSlot: 'dinner' } },
        VERSION,
        LATER,
      );

      expect(result.details).toEqual({ kind: 'meal', mealSlot: 'dinner' });
    });

    it('still converts when objectKind, type and details travel together', async () => {
      seed(meal());

      const result = await patchActivity(
        USER,
        PLAN,
        {
          objectKind: 'plan',
          type: 'watch',
          details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show' },
        },
        VERSION,
        LATER,
      );

      expect(result).toMatchObject({
        objectKind: 'plan',
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show' },
      });
      expect(repository.patchActivity).toHaveBeenCalledTimes(1);
    });
  });
});

describe('convertRecurrence', () => {
  it('atomically keeps the selected effective schedule and leaves OCC history untouched', async () => {
    const current = {
      activityId: PLAN,
      ownerId: USER,
      status: 'scheduled',
      objectKind: 'plan',
      type: 'event',
      title: 'Recurring dinner',
      details: { kind: 'event' },
      schedule: {
        date: '2026-08-01',
        time: '18:00',
        endTime: '20:00',
        timezone: 'America/New_York',
        scheduledAtUtc: '2026-08-01T22:00:00.000Z',
        endAtUtc: '2026-08-02T00:00:00.000Z',
      },
      recurrence: {
        mode: 'fixed',
        segments: [
          { freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00', endTime: '20:00' },
        ],
      },
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: '2026-08-01T00:00:00.000Z',
      lastActivityAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
      schemaVersion: 1,
    } satisfies Activity;
    const occurrence = {
      pk: `ACT#${PLAN}`,
      sk: 'OCC#2026-08-12',
      entity: 'Occurrence',
      activityId: PLAN,
      date: '2026-08-12',
      status: 'rescheduled',
      overrideDate: '2026-08-13',
      overrideTime: '19:30',
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T01:00:00.000Z',
      schemaVersion: 1,
    } satisfies StoredItem;
    vi.mocked(repository.getActivityMeta).mockResolvedValue(current as never);
    vi.mocked(repository.getActivityPartition).mockResolvedValue([
      { ...current, pk: `ACT#${PLAN}`, sk: 'META', entity: 'Activity' },
      occurrence,
    ]);
    vi.mocked(repository.patchActivity).mockClear();

    const result = await convertRecurrence(
      USER,
      PLAN,
      { occurrenceDate: '2026-08-12' },
      NOW,
      () => ({
        userId: USER,
        key: '11111111-1111-4111-8111-111111111111',
        route: 'POST /v1/activities/:id/recurrence/convert',
        status: 200,
        body: '{}',
        createdAt: NOW,
        ttl: 1,
      }),
    );

    expect(result.recurrence).toBeUndefined();
    expect(result.schedule).toMatchObject({
      date: '2026-08-13',
      time: '19:30',
      endTime: '20:00',
      timezone: 'America/New_York',
    });
    expect(repository.patchActivity).toHaveBeenCalledWith(
      USER,
      result,
      current.updatedAt,
      expect.objectContaining({
        occurrenceGuard: {
          date: '2026-08-12',
          kind: 'version',
          updatedAt: occurrence.updatedAt,
        },
      }),
    );
  });
});

/**
 * The 50-prep-task cap and the pointer obligations that come with it (P3-18).
 *
 * The cap is not decoration: it is the reason plan detail may read the complete PREP section
 * in one bounded page and render an exact `3 of 5 done`. So the refusal has to be exact, and
 * it has to write nothing.
 */
describe('the prep-task cap', () => {
  const PARENT_TITLE = 'Poconos trip';

  const plan = (overrides: Partial<Activity> = {}): Activity =>
    ({
      activityId: PLAN,
      ownerId: USER,
      status: 'saved',
      objectKind: 'plan',
      type: 'event',
      title: PARENT_TITLE,
      details: { kind: 'event' },
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
      ...overrides,
    }) as Activity;

  it('refuses the 51st with the exact copy, and writes nothing', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(plan({ childCount: 50 }));

    await expect(
      createActivity(USER, task({ parentActivityId: PLAN }), NOW),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Plan has too many prep tasks.',
      details: [{ path: 'parentActivityId', message: 'Plan has too many prep tasks.' }],
    });

    expect(repository.createActivity).not.toHaveBeenCalled();
  });

  it('accepts the 50th', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(plan({ childCount: 49 }));

    await expect(
      createActivity(USER, task({ parentActivityId: PLAN }), NOW),
    ).resolves.toMatchObject({ activity: { parentActivityId: PLAN } });
  });

  /**
   * A client-minted id at a full plan is ambiguous from `childCount` alone — the fiftieth
   * child is itself one of the fifty. Refusing here would answer a replay "the plan is full"
   * and steer the client away from reading its own id, so the ordered transaction decides:
   * a taken id fails first as a conflict, a genuine 51st reaches the counter condition.
   */
  it('defers a full plan to the transaction when the client minted the id', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(plan({ childCount: 50 }));

    await createActivity(
      USER,
      task({ parentActivityId: PLAN, activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XC' }),
      NOW,
    );

    expect(repository.createActivity).toHaveBeenCalled();
  });

  /** The counter condition losing a race is still the cap, reported after a fresh read. */
  it('turns a lost counter race into the same refusal', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(plan({ childCount: 50 }));
    vi.mocked(repository.createActivity).mockRejectedValueOnce(
      new repository.ParentUnavailableError(),
    );

    await expect(
      createActivity(
        USER,
        task({ parentActivityId: PLAN, activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XC' }),
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Plan has too many prep tasks.',
    });
  });

  /**
   * The attach's three conditions, and which sentence each one earns.
   *
   * These are only reachable as a **race** — the preflight refuses a non-Plan parent and a
   * full plan outright — so they are driven here with the repository mocked rather than in
   * DynamoDB Local, where the interleaving cannot be forced. The first read is the preflight,
   * the second is `parentRejected`'s strong re-read after the transaction cancelled.
   */
  it('reports a parent converted mid-write as not a plan, not as a full one', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(
        plan({ objectKind: 'task', type: 'task', details: { kind: 'task' } } as never),
      );
    vi.mocked(repository.createActivity).mockRejectedValueOnce(
      new repository.ParentUnavailableError(),
    );

    await expect(
      createActivity(
        USER,
        task({ parentActivityId: PLAN, activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XC' }),
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'A prep task belongs to a plan.',
    });
  });

  it('reports a parent deleted mid-write as not_found rather than as a full plan', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(undefined);
    vi.mocked(repository.createActivity).mockRejectedValueOnce(
      new repository.ParentUnavailableError(),
    );

    await expect(
      createActivity(
        USER,
        task({ parentActivityId: PLAN, activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XC' }),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  /**
   * Acceptance criterion 20's storage half: the subtitle a prep task renders with on Today is
   * its parent plan's title, projected onto the index entry at the moment it is created.
   */
  it('carries the parent plan title onto the child’s index entry', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(plan());

    await createActivity(USER, task({ parentActivityId: PLAN }), NOW);

    expect(written()?.[2]).toMatchObject({ taskSubtitle: PARENT_TITLE });
  });

  /**
   * A prep task is a **task** (`plans-and-lists.md` §3). `parentActivityId` sits on the shape
   * both `objectKind` arms share, so nothing in the schema refused an attached Plan — and the
   * row it produced would take a `SUB#` pointer, a slot against the 50-cap, and a place in
   * P3-44's bulk `Complete all` while plan completion is owner-only and global.
   */
  describe('the child of a plan is itself a task', () => {
    it('refuses a Plan created with a parent, and writes nothing', async () => {
      vi.mocked(repository.getActivityMeta).mockResolvedValue(plan());

      await expect(
        createActivity(
          USER,
          task({
            objectKind: 'plan',
            type: 'event',
            details: { kind: 'event' },
            parentActivityId: PLAN,
          }),
          NOW,
        ),
      ).rejects.toMatchObject({
        code: 'validation_failed',
        message: 'Only a task can be a prep task.',
        details: [
          { path: 'parentActivityId', message: 'Only a task can be a prep task.' },
        ],
      });

      expect(repository.createActivity).not.toHaveBeenCalled();
    });

    /**
     * The refusal is on the **child's kind**, before the parent is loaded — so it costs no
     * read and cannot be reached by a caller probing for a parent's existence.
     */
    it('refuses before loading the parent', async () => {
      await expect(
        createActivity(
          USER,
          task({
            objectKind: 'plan',
            type: 'meal',
            details: { kind: 'meal' },
            parentActivityId: PLAN,
          }),
          NOW,
        ),
      ).rejects.toMatchObject({ message: 'Only a task can be a prep task.' });

      expect(repository.getActivityMeta).not.toHaveBeenCalled();
    });

    it('still accepts an ordinary task', async () => {
      vi.mocked(repository.getActivityMeta).mockResolvedValue(plan());

      await expect(
        createActivity(USER, task({ parentActivityId: PLAN }), NOW),
      ).resolves.toMatchObject({ activity: { parentActivityId: PLAN } });
    });
  });
});

/**
 * The counts behind `3 of 5 done` (pattern 16).
 *
 * Exact, because the number is a drill-down: tapping it opens the list it counts, and a
 * figure the user can reach the rows behind must be the figure those rows produce.
 */
describe('getPrepTasks', () => {
  const pointer = (overrides: Partial<PrepTaskPointer> = {}): PrepTaskPointer => ({
    childActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB',
    title: 'Book hotel',
    status: 'saved',
    restoredStatus: 'saved',
    rank: NOW,
    isRecurring: false,
    ...overrides,
  });

  it('returns the whole collection with its exact done and open counts', async () => {
    vi.mocked(repository.listPrepTaskPointers).mockResolvedValue([
      pointer({ childActivityId: 'act_1', status: 'completed' }),
      pointer({ childActivityId: 'act_2', status: 'completed' }),
      pointer({ childActivityId: 'act_3' }),
      pointer({ childActivityId: 'act_4', status: 'scheduled' }),
      pointer({ childActivityId: 'act_5', isRecurring: true }),
    ]);

    const collection = await getPrepTasks(PLAN);

    expect(collection.prepTasks).toHaveLength(5);
    expect(collection.doneCount).toBe(2);
    expect(collection.openCount).toBe(3);
  });

  /** A skipped child is not done. The section counts what is finished, not what is settled. */
  it('counts a skipped child as open', async () => {
    vi.mocked(repository.listPrepTaskPointers).mockResolvedValue([
      pointer({ status: 'skipped' }),
    ]);

    await expect(getPrepTasks(PLAN)).resolves.toMatchObject({
      doneCount: 0,
      openCount: 1,
    });
  });

  it('is zero and zero on a plan with no prep tasks', async () => {
    await expect(getPrepTasks(PLAN)).resolves.toEqual({
      prepTasks: [],
      doneCount: 0,
      openCount: 0,
    });
  });
});

/**
 * Re-parenting through `PATCH` (P3-18).
 *
 * The path the nesting cap could be walked around: `POST` refuses a third level, but until
 * this task a patch could attach a task that already had prep tasks of its own — or attach it
 * to a stranger's activity, whose title the index entry would then render as a subtitle.
 */
describe('changing a task’s parent', () => {
  const CHILD = 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB';
  const OTHER_PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1XD';

  const stored = (overrides: Partial<Activity> = {}): Activity =>
    ({
      activityId: CHILD,
      ownerId: USER,
      status: 'saved',
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      details: { kind: 'task' },
      participantCount: 0,
      childCount: 0,
      expenseTotalCents: 0,
      visibility: 'private',
      icsSequence: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
      ...overrides,
    }) as Activity;

  const plan = (overrides: Partial<Activity> = {}): Activity =>
    stored({
      activityId: PLAN,
      objectKind: 'plan',
      type: 'event',
      title: 'Poconos trip',
      details: { kind: 'event' },
      ...overrides,
    } as Partial<Activity>);

  const patchOptions = () => vi.mocked(repository.patchActivity).mock.calls.at(-1)?.[3];

  beforeEach(() => {
    vi.mocked(repository.patchActivity).mockClear();
    vi.mocked(repository.patchActivity).mockResolvedValue(undefined);
  });

  it('asks the repository to move the pointer and both counters', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(stored({ parentActivityId: PLAN }))
      .mockResolvedValueOnce(plan({ activityId: OTHER_PLAN, title: 'Ski trip' }));

    await patchActivity(USER, CHILD, { parentActivityId: OTHER_PLAN }, NOW, NOW);

    expect(patchOptions()).toMatchObject({
      updateChildPointer: true,
      taskSubtitle: 'Ski trip',
    });
  });

  it('moves the pointer when the parent is cleared', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({ parentActivityId: PLAN }),
    );

    await patchActivity(USER, CHILD, { parentActivityId: null }, NOW, NOW);

    expect(patchOptions()).toMatchObject({ updateChildPointer: true });
    expect(patchOptions()).not.toHaveProperty('taskSubtitle');
  });

  it('refuses a parent that is itself a prep task', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(stored({ activityId: OTHER_PLAN, parentActivityId: PLAN }));

    await expect(
      patchActivity(USER, CHILD, { parentActivityId: OTHER_PLAN }, NOW, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  /** The third level assembled from the other end, which only a patch can reach. */
  it('refuses to attach a task that already has prep tasks of its own', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(stored({ childCount: 2 }))
      .mockResolvedValueOnce(plan());

    await expect(
      patchActivity(USER, CHILD, { parentActivityId: PLAN }, NOW, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed' });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('refuses to make a task its own prep task', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(stored());

    await expect(
      patchActivity(USER, CHILD, { parentActivityId: CHILD }, NOW, NOW),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  /** A stranger's activity is not a parent, and a `404` does not confirm it exists. */
  it('refuses a parent the caller has no relationship to', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(plan({ ownerId: 'usr_someone_else' }));

    await expect(
      patchActivity(USER, CHILD, { parentActivityId: PLAN }, NOW, NOW),
    ).rejects.toMatchObject({ code: 'not_found' });

    expect(repository.patchActivity).not.toHaveBeenCalled();
  });

  it('refuses a plan that is already full', async () => {
    vi.mocked(repository.getActivityMeta)
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(plan({ childCount: 50 }));

    await expect(
      patchActivity(USER, CHILD, { parentActivityId: PLAN }, NOW, NOW),
    ).rejects.toMatchObject({ message: 'Plan has too many prep tasks.' });
  });

  /**
   * The pointer mirrors title, status, schedule-derived restoration state and the recurrence
   * bit, so any of them moving is a pointer rewrite in the same transaction
   * (`api-contract.md` §2.3).
   */
  it('refreshes the pointer when a prep task gains recurrence', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({
        parentActivityId: PLAN,
        status: 'scheduled',
        schedule: {
          date: '2026-08-20',
          timezone: 'America/New_York',
          scheduledAtUtc: '2026-08-20T04:00:00.000Z',
        },
      } as Partial<Activity>),
    );

    await patchActivity(
      USER,
      CHILD,
      {
        recurrence: { mode: 'fixed', segments: [{ freq: 'weekly', byWeekday: [4] }] },
      } as never,
      NOW,
      NOW,
    );

    expect(patchOptions()).toMatchObject({ updateChildPointer: true });
  });

  it('leaves the pointer alone when nothing it mirrors changed', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({ parentActivityId: PLAN }),
    );

    await patchActivity(USER, CHILD, { notes: 'Ask about parking' }, NOW, NOW);

    expect(patchOptions()).not.toHaveProperty('updateChildPointer');
  });
});
