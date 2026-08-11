import type { Activity, Reminder } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertActivityAccess: vi.fn(),
  listForUser: vi.fn<() => Promise<Reminder[]>>(async () => []),
  createForUser: vi.fn(async () => {}),
  deleteForUser: vi.fn(async () => {}),
  drainActivityCleanup: vi.fn(async () => {}),
  executeScheduleCleanup: vi.fn(),
}));

vi.mock('./authz.js', () => ({ assertActivityAccess: mocks.assertActivityAccess }));
vi.mock('../repositories/activityRepository.js', () => ({
  newReminderId: vi.fn(() => 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA'),
}));
vi.mock('../repositories/reminderRepository.js', () => ({
  listForUser: mocks.listForUser,
  createForUser: mocks.createForUser,
  deleteForUser: mocks.deleteForUser,
}));
vi.mock('./idempotencyCleanupService.js', () => ({
  drainActivityCleanup: mocks.drainActivityCleanup,
}));
vi.mock('./scheduleService.js', () => ({
  executeScheduleCleanup: mocks.executeScheduleCleanup,
}));

import { createReminder, listReminders, removeReminder } from './reminderService.js';

const USER = 'usr_alice';
const ACTIVITY_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1AA';
const NOW = '2026-08-11T12:00:00.000Z';

const activity = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: ACTIVITY_ID,
    ownerId: USER,
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'Call dentist',
    schedule: { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const receiptFor = vi.fn((reminder: Reminder) => ({
  userId: USER,
  key: '11111111-1111-4111-8111-111111111111',
  route: 'POST /v1/activities/:id/reminders',
  status: 201,
  body: JSON.stringify(reminder),
  ttl: 1,
  createdAt: NOW,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.assertActivityAccess.mockResolvedValue({
    activity: activity(),
    isOwner: true,
    viaParent: false,
  });
  mocks.listForUser.mockResolvedValue([]);
});

it('lists only through the structurally caller-scoped repository method', async () => {
  await listReminders(USER, ACTIVITY_ID);
  expect(mocks.listForUser).toHaveBeenCalledWith(ACTIVITY_ID, USER);
  expect(mocks.assertActivityAccess).toHaveBeenCalledWith(USER, ACTIVITY_ID, 'read');
});

it('creates a caller-owned reminder and drains earlier same-activity cleanup first', async () => {
  const result = await createReminder(
    USER,
    ACTIVITY_ID,
    { offsetMinutes: -15 },
    NOW,
    receiptFor,
  );

  expect(mocks.drainActivityCleanup).toHaveBeenCalledWith(
    ACTIVITY_ID,
    mocks.executeScheduleCleanup,
  );
  expect(result).toMatchObject({
    userId: USER,
    activityId: ACTIVITY_ID,
    offsetMinutes: -15,
  });
  expect(mocks.createForUser).toHaveBeenCalledWith(
    ACTIVITY_ID,
    USER,
    result,
    NOW,
    expect.objectContaining({ userId: USER }),
  );
});

it('normalises negative zero before storing it', async () => {
  const result = await createReminder(
    USER,
    ACTIVITY_ID,
    { offsetMinutes: -0 },
    NOW,
    receiptFor,
  );
  expect(Object.is(result.offsetMinutes, -0)).toBe(false);
});

it('rejects duplicate offsets as a business conflict before applying the cap', async () => {
  mocks.listForUser.mockResolvedValue(
    [-15, -30, -60].map((offsetMinutes, index) => ({
      reminderId: `rem_01J8XKQ2M4N5P6R7S8T9V0W1${String(index).padStart(2, '0')}`,
      activityId: ACTIVITY_ID,
      userId: USER,
      offsetMinutes,
      channel: 'push' as const,
    })),
  );

  await expect(
    createReminder(USER, ACTIVITY_ID, { offsetMinutes: -15 }, NOW, receiptFor),
  ).rejects.toMatchObject({ code: 'conflict' });
  expect(mocks.createForUser).not.toHaveBeenCalled();
});

it('rejects a fourth caller-owned row with the dedicated 422 error code', async () => {
  mocks.listForUser.mockResolvedValue(
    [-15, -30, -60].map((offsetMinutes, index) => ({
      reminderId: `rem_01J8XKQ2M4N5P6R7S8T9V0W1${String(index).padStart(2, '0')}`,
      activityId: ACTIVITY_ID,
      userId: USER,
      offsetMinutes,
      channel: 'push' as const,
    })),
  );

  await expect(
    createReminder(USER, ACTIVITY_ID, { offsetMinutes: -90 }, NOW, receiptFor),
  ).rejects.toMatchObject({
    code: 'reminder_limit_exceeded',
    message: 'You can add up to 3 reminders.',
  });
});

describe('schedule-aware service validation', () => {
  it('rejects every operation on an undated activity', async () => {
    const undated = activity();
    delete (undated as { schedule?: unknown }).schedule;
    mocks.assertActivityAccess.mockResolvedValue({
      activity: undated,
      isOwner: true,
      viaParent: false,
    });

    await expect(listReminders(USER, ACTIVITY_ID)).rejects.toMatchObject({
      code: 'validation_failed',
    });
    await expect(
      createReminder(USER, ACTIVITY_ID, { offsetMinutes: 0 }, NOW, receiptFor),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(removeReminder(USER, ACTIVITY_ID, 'rem_missing')).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });

  it('accepts sub-day timed offsets and rejects them for date-only activities', async () => {
    await expect(
      createReminder(USER, ACTIVITY_ID, { offsetMinutes: -15 }, NOW, receiptFor),
    ).resolves.toMatchObject({ offsetMinutes: -15 });

    mocks.assertActivityAccess.mockResolvedValue({
      activity: activity({ schedule: { date: '2026-08-12', timezone: 'UTC' } }),
      isOwner: true,
      viaParent: false,
    });
    await expect(
      createReminder(USER, ACTIVITY_ID, { offsetMinutes: -15 }, NOW, receiptFor),
    ).rejects.toMatchObject({ name: 'ZodError' });
  });
});

it('deletes only from the caller prefix', async () => {
  await expect(removeReminder(USER, ACTIVITY_ID, 'rem_owned')).resolves.toBe('rem_owned');
  expect(mocks.deleteForUser).toHaveBeenCalledWith(ACTIVITY_ID, USER, 'rem_owned');
});

it('maps a missing caller-owned row, including somebody else’s id, to not_found', async () => {
  const failure = new Error('missing');
  failure.name = 'ConditionalCheckFailedException';
  mocks.deleteForUser.mockRejectedValue(failure);

  await expect(removeReminder(USER, ACTIVITY_ID, 'rem_other')).rejects.toMatchObject({
    code: 'not_found',
  });
});
