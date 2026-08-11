import { beforeAll, describe, expect, it } from 'vitest';
import { authedHeaders, withUser } from '../helpers/auth.js';
import { useTestTable } from './harness.js';

useTestTable();

type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type ReminderRepo = typeof import('../../src/repositories/reminderRepository.js');
type ActivityRepo = typeof import('../../src/repositories/activityRepository.js');
type IdempotencyRepo = typeof import('../../src/repositories/idempotencyRepository.js');
type ScheduleService = typeof import('../../src/services/scheduleService.js');

let base: Base;
let keys: Keys;
let reminders: ReminderRepo;
let activities: ActivityRepo;
let idempotency: IdempotencyRepo;
let scheduleService: ScheduleService;

const OWNER = 'usr_local_dev';
const PARTICIPANT = 'usr_reminders_participant';

beforeAll(async () => {
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  reminders = await import('../../src/repositories/reminderRepository.js');
  activities = await import('../../src/repositories/activityRepository.js');
  idempotency = await import('../../src/repositories/idempotencyRepository.js');
  scheduleService = await import('../../src/services/scheduleService.js');
});

async function createActivity(options: {
  schedule?: { date: string; time?: string; timezone: string };
  reminderOffsets?: number[];
}) {
  const response = await withUser(OWNER).fetch(
    new Request('http://localhost/v1/activities', {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
      body: JSON.stringify({
        objectKind: 'task',
        type: 'task',
        title: 'Call dentist',
        ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
        ...(options.reminderOffsets === undefined
          ? {}
          : {
              reminders: options.reminderOffsets.map((offsetMinutes) => ({
                offsetMinutes,
              })),
            }),
      }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data as { activityId: string };
}

async function addParticipant(activityId: string): Promise<void> {
  const now = '2026-08-11T12:00:00.000Z';
  await base.putItem({
    ...keys.participant(activityId, 'psn_reminders_participant'),
    entity: 'Participant',
    activityId,
    personId: 'psn_reminders_participant',
    userId: PARTICIPANT,
    role: 'participant',
    rsvp: 'pending',
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
}

const list = (userId: string, activityId: string) =>
  withUser(userId).fetch(
    new Request(`http://localhost/v1/activities/${activityId}/reminders`),
  );

const create = (
  userId: string,
  activityId: string,
  offsetMinutes: number,
  idempotencyKey = crypto.randomUUID(),
) =>
  withUser(userId).fetch(
    new Request(`http://localhost/v1/activities/${activityId}/reminders`, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey }),
      body: JSON.stringify({ offsetMinutes }),
    }),
  );

const remove = (userId: string, activityId: string, reminderId: string) =>
  withUser(userId).fetch(
    new Request(`http://localhost/v1/activities/${activityId}/reminders/${reminderId}`, {
      method: 'DELETE',
      headers: authedHeaders(),
    }),
  );

describe('two users on one activity', () => {
  it('never exposes the owner’s reminder ids, offsets, or count to a participant', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
      reminderOffsets: [-15, -90],
    });
    await addParticipant(activity.activityId);
    const ownerRows = await reminders.listForUser(activity.activityId, OWNER);

    const response = await list(PARTICIPANT, activity.activityId);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).data).toEqual([]);
    for (const row of ownerRows) {
      expect(text).not.toContain(row.reminderId);
      expect(text).not.toContain(String(row.offsetMinutes));
    }
  });

  it('lets a participant create only their row and leaves the owner set unchanged', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
      reminderOffsets: [-15],
    });
    await addParticipant(activity.activityId);

    const response = await create(PARTICIPANT, activity.activityId, -45);
    expect(response.status).toBe(201);
    expect(await reminders.listForUser(activity.activityId, OWNER)).toHaveLength(1);
    expect(await reminders.listForUser(activity.activityId, PARTICIPANT)).toMatchObject([
      { userId: PARTICIPANT, offsetMinutes: -45 },
    ]);
  });

  it('returns 404 when a participant deletes the owner’s id and leaves it intact', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
      reminderOffsets: [-15],
    });
    await addParticipant(activity.activityId);
    const [ownerReminder] = await reminders.listForUser(activity.activityId, OWNER);
    if (ownerReminder === undefined) throw new Error('owner reminder missing');

    const response = await remove(
      PARTICIPANT,
      activity.activityId,
      ownerReminder.reminderId,
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
    expect(await reminders.listForUser(activity.activityId, OWNER)).toEqual([
      ownerReminder,
    ]);
  });

  it('caps each user separately rather than the activity as a whole', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
    });
    await addParticipant(activity.activityId);

    for (const offset of [-15, -30, -60]) {
      expect((await create(OWNER, activity.activityId, offset)).status).toBe(201);
    }
    const fourthOwner = await create(OWNER, activity.activityId, -90);
    expect(fourthOwner.status).toBe(422);
    expect((await fourthOwner.json()).error.code).toBe('reminder_limit_exceeded');

    expect((await create(PARTICIPANT, activity.activityId, -90)).status).toBe(201);
    expect(await reminders.listForUser(activity.activityId, OWNER)).toHaveLength(3);
    expect(await reminders.listForUser(activity.activityId, PARTICIPANT)).toHaveLength(1);
  });
});

describe('validation and idempotency', () => {
  it('rejects a positive offset', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
    });
    const response = await create(OWNER, activity.activityId, 30);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('validation_failed');
  });

  it('rejects reminder management for an undated activity', async () => {
    const activity = await createActivity({});
    expect((await list(OWNER, activity.activityId)).status).toBe(400);
    expect((await create(OWNER, activity.activityId, 0)).status).toBe(400);
  });

  it('replays one key with the original id and rejects a new key at that offset', async () => {
    const activity = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
    });
    const idempotencyKey = crypto.randomUUID();
    const first = await create(OWNER, activity.activityId, -15, idempotencyKey);
    const firstText = await first.text();
    const replay = await create(OWNER, activity.activityId, -15, idempotencyKey);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(firstText);
    expect(await reminders.listForUser(activity.activityId, OWNER)).toHaveLength(1);
    expect((await create(OWNER, activity.activityId, -15)).status).toBe(409);
  });

  it('accepts timed sub-day offsets and only whole-day date-only offsets', async () => {
    const timed = await createActivity({
      schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
    });
    expect((await create(OWNER, timed.activityId, -15)).status).toBe(201);

    for (const offset of [0, -1440, -10080]) {
      const dateOnly = await createActivity({
        schedule: { date: '2026-08-15', timezone: 'UTC' },
      });
      expect((await create(OWNER, dateOnly.activityId, offset)).status).toBe(201);
    }
    for (const offset of [-15, -1439]) {
      const dateOnly = await createActivity({
        schedule: { date: '2026-08-15', timezone: 'UTC' },
      });
      expect((await create(OWNER, dateOnly.activityId, offset)).status).toBe(400);
    }
  });
});

it('unscheduling deletes every user’s reminder rows through the durable cleanup path', async () => {
  const activity = await createActivity({
    schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
    reminderOffsets: [-15],
  });
  await addParticipant(activity.activityId);
  expect((await create(PARTICIPANT, activity.activityId, -45)).status).toBe(201);

  const response = await withUser(OWNER).fetch(
    new Request(`http://localhost/v1/activities/${activity.activityId}/schedule`, {
      method: 'POST',
      headers: authedHeaders({ idempotencyKey: crypto.randomUUID() }),
      body: JSON.stringify({ date: null }),
    }),
  );

  expect(response.status).toBe(200);
  expect(await reminders.listForUser(activity.activityId, OWNER)).toEqual([]);
  expect(await reminders.listForUser(activity.activityId, PARTICIPANT)).toEqual([]);
});

async function seedLargeReminderSet(activityId: string): Promise<Map<string, number>> {
  const expected = new Map<string, number>();
  const now = '2026-08-11T12:00:00.000Z';
  const offsets = [-15, -720, -1440] as const;
  for (let index = 0; index < 30; index += 1) {
    const reminderId = activities.newReminderId();
    const offsetMinutes = offsets[index % offsets.length] ?? -15;
    expected.set(reminderId, scheduleService.normaliseReminderOffset(offsetMinutes));
    await base.putItem({
      ...keys.reminder(
        activityId,
        `usr_cleanup_${String(index).padStart(2, '0')}`,
        reminderId,
      ),
      entity: 'Reminder',
      reminderId,
      activityId,
      userId: `usr_cleanup_${String(index).padStart(2, '0')}`,
      offsetMinutes,
      channel: 'push',
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    });
  }
  return expected;
}

it('resumes a large time-removal normalization after a crash between effect and cursor save', async () => {
  const { activityId } = await createActivity({
    schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
  });
  const expected = await seedLargeReminderSet(activityId);
  const previous = await activities.getActivityMeta(activityId);
  if (previous === undefined) throw new Error('activity missing');

  const key = crypto.randomUUID();
  const ref = { activityId, userId: OWNER, idempotencyKey: key };
  const now = '2026-08-11T12:01:00.000Z';
  const work = {
    ...ref,
    phases: [{ kind: 'normalise_untimed_reminders' as const, complete: false }],
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1 as const,
  };
  const next = {
    ...previous,
    schedule: { date: '2026-08-15', timezone: 'UTC' },
    icsSequence: previous.icsSequence + 1,
    updatedAt: now,
  };
  await activities.writeSchedule(next, {
    previous,
    indexedUserIds: [OWNER],
    idempotencyReceipt: {
      userId: OWNER,
      key,
      route: 'POST /v1/activities/:id/schedule',
      status: 200,
      body: '{}',
      ttl: 1,
      createdAt: now,
      cleanupRef: ref,
    },
    cleanupWork: work,
  });

  const phase = work.phases[0];
  if (phase === undefined) throw new Error('cleanup phase missing');
  const first = await scheduleService.executeScheduleCleanup(work, phase);
  expect(first.complete).toBe(false);
  // Simulated crash: the effect landed, but saveCleanupProgress did not.
  expect((await idempotency.loadCleanup(ref))?.phases[0]).toEqual(phase);

  await scheduleService.drainScheduleCleanup(ref);
  expect(await idempotency.loadCleanup(ref)).toBeUndefined();
  const rows = (await activities.getActivityPartition(activityId)).filter(
    (row) => row.entity === 'Reminder',
  );
  expect(rows).toHaveLength(30);
  for (const row of rows) {
    expect(row.offsetMinutes).toBe(expected.get(String(row.reminderId)));
  }
});

it('resumes a large unschedule deletion after a crash and removes every user row', async () => {
  const { activityId } = await createActivity({
    schedule: { date: '2026-08-15', time: '18:00', timezone: 'UTC' },
  });
  await seedLargeReminderSet(activityId);
  const previous = await activities.getActivityMeta(activityId);
  if (previous === undefined) throw new Error('activity missing');

  const key = crypto.randomUUID();
  const ref = { activityId, userId: OWNER, idempotencyKey: key };
  const now = '2026-08-11T12:02:00.000Z';
  const work = {
    ...ref,
    phases: [{ kind: 'delete_reminders' as const, complete: false }],
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1 as const,
  };
  const next = {
    ...previous,
    status: 'saved' as const,
    icsSequence: previous.icsSequence + 1,
    updatedAt: now,
  };
  delete (next as { schedule?: unknown }).schedule;
  await activities.writeSchedule(next, {
    previous,
    indexedUserIds: [OWNER],
    idempotencyReceipt: {
      userId: OWNER,
      key,
      route: 'POST /v1/activities/:id/schedule',
      status: 200,
      body: '{}',
      ttl: 1,
      createdAt: now,
      cleanupRef: ref,
    },
    cleanupWork: work,
  });

  const phase = work.phases[0];
  if (phase === undefined) throw new Error('cleanup phase missing');
  const first = await scheduleService.executeScheduleCleanup(work, phase);
  expect(first.complete).toBe(false);
  expect(
    (await activities.getActivityPartition(activityId)).filter(
      (row) => row.entity === 'Reminder',
    ),
  ).toHaveLength(5);
  expect((await idempotency.loadCleanup(ref))?.phases[0]).toEqual(phase);

  await scheduleService.drainScheduleCleanup(ref);
  expect(await idempotency.loadCleanup(ref)).toBeUndefined();
  expect(
    (await activities.getActivityPartition(activityId)).filter(
      (row) => row.entity === 'Reminder',
    ),
  ).toEqual([]);
});
