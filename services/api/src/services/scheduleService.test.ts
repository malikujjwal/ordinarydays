import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CleanupRef, IdempotencyReceipt } from '../lib/idempotency.js';
import type { ScheduleWriteOptions } from '../repositories/activityRepository.js';
import type { StoredItem } from '../repositories/migrate.js';

const mocks = vi.hoisted(() => ({
  assertActivityAccess: vi.fn(),
  listParticipants: vi.fn<() => Promise<StoredItem[]>>(async () => []),
  writeSchedule: vi.fn<(next: Activity, options: ScheduleWriteOptions) => Promise<void>>(
    async () => {},
  ),
  getActivityMeta: vi.fn(),
  listScheduleCleanupBatch: vi.fn(),
  writeScheduleCleanupBatch: vi.fn(),
  getOccurrence: vi.fn(async () => null),
  getMoveMarker: vi.fn(async () => null),
  writeOccurrenceSchedule: vi.fn(async () => {}),
  drainActivityCleanup: vi.fn(async () => {}),
  drainCleanup: vi.fn(async () => {}),
}));

vi.mock('../repositories/activityRepository.js', () => ({
  listParticipants: mocks.listParticipants,
  writeSchedule: mocks.writeSchedule,
  getActivityMeta: mocks.getActivityMeta,
  listScheduleCleanupBatch: mocks.listScheduleCleanupBatch,
  writeScheduleCleanupBatch: mocks.writeScheduleCleanupBatch,
}));
vi.mock('../repositories/occurrenceRepository.js', () => ({
  get: mocks.getOccurrence,
  getMoveMarker: mocks.getMoveMarker,
  writeOccurrenceSchedule: mocks.writeOccurrenceSchedule,
}));
vi.mock('./idempotencyCleanupService.js', () => ({
  drainActivityCleanup: mocks.drainActivityCleanup,
  drainCleanup: mocks.drainCleanup,
}));
vi.mock('./authz.js', () => ({ assertActivityAccess: mocks.assertActivityAccess }));

import {
  executeScheduleCleanup,
  normaliseReminderOffset,
  scheduleActivity,
} from './scheduleService.js';

const USER = 'usr_owner';
const ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const NOW = '2026-08-11T12:00:00.000Z';

const stored = (overrides: Record<string, unknown> = {}): Activity =>
  ({
    activityId: ID,
    ownerId: USER,
    objectKind: 'task',
    type: 'task',
    status: 'saved',
    title: 'Call the dentist',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const receiptFor = (data: unknown, cleanupRef?: CleanupRef): IdempotencyReceipt => ({
  userId: USER,
  key: '11111111-1111-4111-8111-111111111111',
  route: 'POST /v1/activities/:id/schedule',
  status: 200,
  body: JSON.stringify({ data }),
  ttl: 1,
  createdAt: NOW,
  ...(cleanupRef === undefined ? {} : { cleanupRef }),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertActivityAccess.mockResolvedValue({
    activity: stored(),
    isOwner: true,
    viaParent: false,
  });
  mocks.listParticipants.mockResolvedValue([]);
});

describe('whole-activity scheduling', () => {
  it('rejects a timezone Intl does not recognise before any schedule write', async () => {
    await expect(
      scheduleActivity(
        USER,
        ID,
        { date: '2026-08-12', timezone: 'Mars/Olympus_Mons' },
        'UTC',
        NOW,
        receiptFor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mocks.writeSchedule).not.toHaveBeenCalled();
  });

  it('derives status, UTC and one icsSequence bump', async () => {
    const result = await scheduleActivity(
      USER,
      ID,
      { date: '2026-03-08', time: '02:30', timezone: 'America/New_York' },
      'UTC',
      NOW,
      receiptFor,
    );

    expect(result.activity).toMatchObject({
      status: 'scheduled',
      icsSequence: 1,
      schedule: { scheduledAtUtc: '2026-03-08T07:00:00.000Z' },
    });
  });

  it('does not bump sequence for an identical request and preserves terminal status', async () => {
    const current = stored({
      status: 'completed',
      icsSequence: 8,
      schedule: {
        date: '2026-08-12',
        time: '18:00',
        timezone: 'UTC',
        scheduledAtUtc: '2026-08-12T18:00:00.000Z',
      },
    });
    mocks.assertActivityAccess.mockResolvedValue({
      activity: current,
      isOwner: true,
      viaParent: false,
    });

    const result = await scheduleActivity(
      USER,
      ID,
      { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
      'UTC',
      NOW,
      receiptFor,
    );
    expect(result.activity).toMatchObject({ status: 'completed', icsSequence: 8 });
  });

  it('resets non-declined RSVP on date change but not declined rows', async () => {
    mocks.listParticipants.mockResolvedValue([
      {
        pk: `ACT#${ID}`,
        sk: 'PART#a',
        entity: 'Participant',
        rsvp: 'going',
        respondedAt: NOW,
      },
      {
        pk: `ACT#${ID}`,
        sk: 'PART#b',
        entity: 'Participant',
        rsvp: 'declined',
        respondedAt: NOW,
      },
    ]);

    const result = await scheduleActivity(
      USER,
      ID,
      { date: '2026-08-12', timezone: 'UTC' },
      'UTC',
      NOW,
      receiptFor,
    );
    expect(result.rsvpReset).toBe(true);
    const options = mocks.writeSchedule.mock.calls[0]?.[1];
    expect(options?.participantRows).toEqual([
      expect.objectContaining({ rsvp: 'pending', rsvpForDate: '2026-08-12' }),
    ]);
  });

  it('defers participant reset at 46 and persists the marker plus cleanup', async () => {
    mocks.listParticipants.mockResolvedValue(
      Array.from({ length: 46 }, (_, index) => ({
        pk: `ACT#${ID}`,
        sk: `PART#${String(index).padStart(2, '0')}`,
        entity: 'Participant',
        rsvp: 'going',
      })),
    );
    await scheduleActivity(
      USER,
      ID,
      { date: '2026-08-12', timezone: 'UTC' },
      'UTC',
      NOW,
      receiptFor,
    );
    expect(mocks.writeSchedule.mock.calls[0]?.[1]).toMatchObject({
      rsvpResetPending: true,
      cleanupWork: { phases: [{ kind: 'reset_rsvp', complete: false }] },
    });
  });

  it('flags timed to date-only and persists normalisation without disclosing rows', async () => {
    mocks.assertActivityAccess.mockResolvedValue({
      activity: stored({
        status: 'scheduled',
        schedule: {
          date: '2026-08-12',
          time: '18:00',
          timezone: 'UTC',
          scheduledAtUtc: '2026-08-12T18:00:00.000Z',
        },
      }),
      isOwner: true,
      viaParent: false,
    });
    const result = await scheduleActivity(
      USER,
      ID,
      { date: '2026-08-12', timezone: 'UTC' },
      'UTC',
      NOW,
      receiptFor,
    );
    expect(result).toMatchObject({ reminderOffsetsNormalized: true });
    expect(mocks.writeSchedule.mock.calls[0]?.[1]).toMatchObject({
      cleanupWork: {
        phases: [{ kind: 'normalise_untimed_reminders', complete: false }],
      },
    });
  });
});

describe('occurrence scheduling', () => {
  const recurring = stored({
    status: 'scheduled',
    schedule: { date: '2026-08-01', time: '18:00', timezone: 'UTC' },
    recurrence: {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '18:00' }],
    },
  });

  it('accepts an exact 60-day cross-day move and leaves META as the response', async () => {
    mocks.assertActivityAccess.mockResolvedValue({
      activity: recurring,
      isOwner: true,
      viaParent: false,
    });
    const result = await scheduleActivity(
      USER,
      ID,
      { date: '2026-09-30', occurrenceDate: '2026-08-01', timezone: 'UTC' },
      'UTC',
      NOW,
      receiptFor,
    );
    expect(result.activity).toEqual(recurring);
    expect(mocks.writeSchedule).not.toHaveBeenCalled();
    expect(mocks.writeOccurrenceSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ newDestination: '2026-09-30' }),
    );
  });

  it('rejects a 61-day move without writing', async () => {
    mocks.assertActivityAccess.mockResolvedValue({
      activity: recurring,
      isOwner: true,
      viaParent: false,
    });
    await expect(
      scheduleActivity(
        USER,
        ID,
        { date: '2026-10-01', occurrenceDate: '2026-08-01', timezone: 'UTC' },
        'UTC',
        NOW,
        receiptFor,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mocks.writeOccurrenceSchedule).not.toHaveBeenCalled();
  });
});

it.each([
  [-719, 0],
  [-720, -1440],
  [-721, -1440],
  [-2160, -2880],
  [-1440, -1440],
])('normalises reminder offset %i to %i', (input, expected) => {
  expect(normaliseReminderOffset(input)).toBe(expected);
});

it('advances a resumable reminder cleanup page from its last sort key', async () => {
  mocks.listScheduleCleanupBatch.mockResolvedValue({
    rows: [
      { pk: `ACT#${ID}`, sk: 'REM#usr_a#rem_1', entity: 'Reminder', offsetMinutes: -720 },
      { pk: `ACT#${ID}`, sk: 'REM#usr_b#rem_2', entity: 'Reminder', offsetMinutes: -60 },
    ],
    complete: false,
  });
  await expect(
    executeScheduleCleanup(
      {
        activityId: ID,
        userId: USER,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        phases: [],
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      },
      { kind: 'normalise_untimed_reminders', complete: false },
    ),
  ).resolves.toEqual({ cursor: 'REM#usr_b#rem_2', complete: false });
  expect(mocks.writeScheduleCleanupBatch).toHaveBeenCalledWith(
    ID,
    [
      expect.objectContaining({ offsetMinutes: -1440 }),
      expect.objectContaining({ offsetMinutes: 0 }),
    ],
    {},
  );
});

it('deletes a complete reminder cleanup page without returning a cursor', async () => {
  const rows = [{ pk: `ACT#${ID}`, sk: 'REM#usr_a#rem_1', entity: 'Reminder' }];
  mocks.listScheduleCleanupBatch.mockResolvedValue({ rows, complete: true });

  await expect(
    executeScheduleCleanup(
      {
        activityId: ID,
        userId: USER,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        phases: [],
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      },
      { kind: 'delete_reminders', complete: false },
    ),
  ).resolves.toEqual({ cursor: 'REM#usr_a#rem_1', complete: true });
  expect(mocks.writeScheduleCleanupBatch).toHaveBeenCalledWith(ID, rows, {
    deleteRows: true,
  });
});

it('finishes deferred RSVP cleanup safely after the activity was deleted', async () => {
  mocks.listScheduleCleanupBatch.mockResolvedValue({ rows: [], complete: true });
  mocks.getActivityMeta.mockResolvedValue(undefined);

  await expect(
    executeScheduleCleanup(
      {
        activityId: ID,
        userId: USER,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        phases: [],
        createdAt: NOW,
        updatedAt: NOW,
        schemaVersion: 1,
      },
      { kind: 'reset_rsvp', complete: false },
    ),
  ).resolves.toEqual({ complete: true });
  expect(mocks.writeScheduleCleanupBatch).toHaveBeenCalledWith(ID, [], {});
});

it('applies a deferred RSVP reset and clears its pending marker on the final page', async () => {
  const participant = {
    pk: `ACT#${ID}`,
    sk: 'PART#person_1',
    entity: 'Participant',
    rsvp: 'going',
    respondedAt: NOW,
  };
  mocks.listScheduleCleanupBatch.mockResolvedValue({
    rows: [participant],
    complete: true,
  });
  mocks.getActivityMeta.mockResolvedValue(
    stored({ schedule: { date: '2026-08-12', timezone: 'UTC' } }),
  );

  await executeScheduleCleanup(
    {
      activityId: ID,
      userId: USER,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
      phases: [],
      createdAt: NOW,
      updatedAt: NOW,
      schemaVersion: 1,
    },
    { kind: 'reset_rsvp', complete: false },
  );
  expect(mocks.writeScheduleCleanupBatch).toHaveBeenCalledWith(
    ID,
    [
      expect.objectContaining({
        rsvp: 'pending',
        rsvpForDate: '2026-08-12',
      }),
    ],
    { clearRsvpPending: true },
  );
});
