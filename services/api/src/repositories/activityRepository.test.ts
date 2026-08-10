import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Activity } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createActivity,
  localDateTime,
  newActivityId,
  newReminderId,
  patchActivity,
} from './activityRepository.js';

/**
 * The derivation rules, and *did we compose the right transaction*.
 *
 * The behaviour — that a query with these keys comes back with these rows — is asserted
 * against DynamoDB Local in `test/integration/activityRepository.int.test.ts`. What a mock
 * answers and a database cannot is which key each bucket produces: a sort key composed from
 * the wrong field still writes, still reads back, and only sorts wrongly — months later, on
 * somebody's agenda.
 *
 * The traffic runs the other way too, and did: the integration suite caught that the
 * "delete and re-put the index entry" instruction is not executable, because both operations
 * land on the same item. No mock would have said so.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

const ALICE = 'usr_a';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const activity = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: ACT,
    ownerId: ALICE,
    objectKind: 'task',
    type: 'task',
    status: 'saved',
    title: 'Buy milk',
    details: { kind: 'task' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const plan = (overrides: Partial<Activity> = {}) =>
  activity({
    objectKind: 'plan',
    type: 'custom',
    details: { kind: 'custom' },
    ...overrides,
  } as Partial<Activity>);

const schedule = { date: '2026-08-15', timezone: 'America/New_York' };
const series = {
  mode: 'fixed' as const,
  segments: [{ freq: 'weekly' as const, effectiveFrom: '2026-08-01' }],
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
});

const sentItems = () =>
  (ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0]?.input.TransactItems ??
    []) as Array<Record<string, { Item?: Record<string, unknown>; Key?: unknown }>>;

const verbs = () => sentItems().map((entry) => Object.keys(entry)[0]);

/**
 * The `act_` and `rem_` generators (P1-10), which the service calls before handing this layer
 * a fully-formed row. Same properties `newUserId` and `newDeviceId` are held to.
 */
describe('id generation', () => {
  it.each([
    ['newActivityId', newActivityId, /^act_[0-9A-HJKMNP-TV-Z]{26}$/],
    ['newReminderId', newReminderId, /^rem_[0-9A-HJKMNP-TV-Z]{26}$/],
  ])('%s is its prefix plus a 26-character ULID', (_name, mint, shape) => {
    expect(mint()).toMatch(shape);
  });

  it.each([
    ['newActivityId', newActivityId],
    ['newReminderId', newReminderId],
  ])('%s is unique across calls', (_name, mint) => {
    expect(new Set(Array.from({ length: 50 }, mint)).size).toBe(50);
  });

  /**
   * A create mints an activity id and up to three reminder ids in one tick. Plain `ulid()`
   * would break the tie with random bits and sort them arbitrarily, which is the
   * time-ordering guarantee `data-model.md` §8 says the prefix-ULID choice was made for.
   */
  it.each([
    ['newActivityId', newActivityId],
    ['newReminderId', newReminderId],
  ])('%s sorts by creation time even within one millisecond', (_name, mint) => {
    const ids = Array.from({ length: 20 }, mint);
    expect([...ids].sort()).toEqual(ids);
  });

  it('passes the shared schemas', async () => {
    const { ulidId } = await import('@od/shared/schemas');

    expect(ulidId('act').safeParse(newActivityId()).success).toBe(true);
    expect(ulidId('rem').safeParse(newReminderId()).success).toBe(true);
  });
});

describe('the scheduled sort key', () => {
  it('composes the user’s local wall clock, with no timezone maths', () => {
    expect(localDateTime({ date: '2026-08-15', time: '19:30' })).toBe('2026-08-15T19:30');
  });

  /**
   * Untimed items sort **before** timed ones on the same date, because `00:00` sorts first.
   * That is the intended order and Phase 2's agenda partitioning depends on it.
   */
  it('gives an untimed item 00:00, so it sorts first on its date', () => {
    expect(localDateTime({ date: '2026-08-15' })).toBe('2026-08-15T00:00');
    expect(
      localDateTime({ date: '2026-08-15' }) <
        localDateTime({ date: '2026-08-15', time: '00:01' }),
    ).toBe(true);
  });
});

describe('the index entry’s GSI1 keys', () => {
  const indexOf = () =>
    sentItems().find((entry) => (entry.Put?.Item?.sk as string)?.startsWith('IDX#'))?.Put
      ?.Item as Record<string, unknown>;

  it.each([
    [
      'S',
      activity({ schedule: { ...schedule, time: '19:30' } }),
      `U#${ALICE}#S`,
      `2026-08-15T19:30#${ACT}`,
    ],
    ['P', plan(), `U#${ALICE}#P`, `2026-08-08T10:00:00.000Z#${ACT}`],
    ['N', activity(), `U#${ALICE}#N`, `2026-08-08T10:00:00.000Z#${ACT}`],
    ['R', activity({ recurrence: series }), `U#${ALICE}#R`, `2026-08-01#${ACT}`],
  ])('bucket %s', async (_bucket, subject, gsi1pk, gsi1sk) => {
    await createActivity(ALICE, subject);
    expect(indexOf()).toMatchObject({ gsi1pk, gsi1sk });
  });

  /**
   * The recurring sort key is the **first** segment's anchor, not the active one — it is
   * immutable, so an "all future occurrences" edit that appends a segment never rewrites
   * this key.
   */
  it('anchors a series on its first segment, not its latest', async () => {
    await createActivity(
      ALICE,
      activity({
        recurrence: {
          mode: 'fixed',
          segments: [
            { freq: 'weekly', effectiveFrom: '2026-01-01' },
            { freq: 'weekly', effectiveFrom: '2026-08-01' },
          ],
        },
      }),
    );

    expect(indexOf()?.gsi1sk).toBe(`2026-01-01#${ACT}`);
  });

  it('projects the AgendaItem fields the index is meant to carry', async () => {
    await createActivity(
      ALICE,
      plan({
        type: 'event',
        details: { kind: 'event', organiser: 'Dr Patel' },
        location: { label: 'Zahav' },
        schedule: { ...schedule, time: '19:00', endTime: '21:00' },
      }),
    );

    expect(indexOf()).toMatchObject({
      activityId: ACT,
      type: 'event',
      title: 'Buy milk',
      status: 'saved',
      time: '19:00',
      endTime: '21:00',
      isRecurring: false,
      participantAvatars: [],
      participantCount: 0,
      locationLabel: 'Zahav',
      subtitle: 'Dr Patel',
    });
  });

  it.each([
    [
      'meal with a slot',
      plan({ type: 'meal', details: { kind: 'meal', mealSlot: 'dinner' } }),
      'Meal · Dinner',
    ],
    [
      'watch with an episode',
      plan({
        type: 'watch',
        details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
      }),
      'Watch · S2 E4',
    ],
    [
      'event with an organiser',
      plan({ type: 'event', details: { kind: 'event', organiser: 'Union Transfer' } }),
      'Union Transfer',
    ],
  ])('derives the %s subtitle', async (_why, subject, expected) => {
    await createActivity(ALICE, subject);
    expect(indexOf()?.subtitle).toBe(expected);
  });

  /**
   * A task's subtitle is its parent plan's **title**, which this layer cannot see. The
   * service supplies it — P1-10 already loads the parent to enforce the nesting cap, so no
   * extra read enters the write path.
   */
  it('takes a task’s subtitle from the caller, since the parent title is not here', async () => {
    await createActivity(ALICE, activity({ parentActivityId: 'act_parent' }), {
      taskSubtitle: 'New York Trip',
    });
    expect(indexOf()?.subtitle).toBe('New York Trip');
  });

  it('leaves a custom activity with no subtitle', async () => {
    await createActivity(ALICE, plan());
    expect(indexOf()).not.toHaveProperty('subtitle');
  });
});

describe('create composes one transaction', () => {
  it('writes META and the owner’s index entry', async () => {
    await createActivity(ALICE, activity());

    expect(verbs()).toEqual(['Put', 'Put']);
    expect(sentItems()[0]?.Put?.Item).toMatchObject({
      pk: `ACT#${ACT}`,
      sk: 'META',
      entity: 'Activity',
      schemaVersion: 1,
    });
  });

  /**
   * Reminders belong to the **creator alone**. There is no path in this phase or any later
   * one by which one user's create writes a reminder for another (ADR-047).
   */
  it('writes one REM# row per reminder, all carrying the creator’s id', async () => {
    await createActivity(ALICE, activity(), {
      reminders: [
        { reminderId: 'rem_1', offsetMinutes: -15 },
        { reminderId: 'rem_2', offsetMinutes: -60 },
      ],
    });

    const reminders = sentItems()
      .map((entry) => entry.Put?.Item)
      .filter((item) => (item?.sk as string)?.startsWith('REM#'));

    expect(reminders).toHaveLength(2);
    expect(reminders.every((row) => row?.userId === ALICE)).toBe(true);
    expect(reminders.map((row) => row?.sk)).toEqual([
      `REM#${ALICE}#rem_1`,
      `REM#${ALICE}#rem_2`,
    ]);
  });

  it('writes the parent’s SUB# pointer when the activity has a parent', async () => {
    await createActivity(ALICE, activity({ parentActivityId: 'act_parent' }));

    const pointer = sentItems()
      .map((entry) => entry.Put?.Item)
      .find((item) => (item?.sk as string)?.startsWith('SUB#'));

    expect(pointer).toMatchObject({
      pk: 'ACT#act_parent',
      sk: `SUB#${ACT}`,
      entity: 'ChildPointer',
      childActivityId: ACT,
      title: 'Buy milk',
      status: 'saved',
    });
  });

  it('writes no pointer when there is no parent', async () => {
    await createActivity(ALICE, activity());
    expect(sentItems().some((e) => (e.Put?.Item?.sk as string)?.startsWith('SUB#'))).toBe(
      false,
    );
  });
});

describe('patch', () => {
  it('is conditional on the updatedAt the caller read', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity({ title: 'Buy oat milk' }), previous.updatedAt, {
      previous,
    });

    expect(sentItems()[0]?.Put).toMatchObject({
      ConditionExpression: '#updatedAt = :expected',
      ExpressionAttributeValues: { ':expected': previous.updatedAt },
    });
  });

  /**
   * **The one that matters, in its corrected form.** The index entry keeps its primary key
   * across a bucket change — only `gsi1pk`/`gsi1sk` move — so a whole-item `Put` is what
   * relocates the GSI projection. A `Delete` beside it is not merely redundant: DynamoDB
   * rejects two operations on one item in a transaction, which the integration suite proved.
   */
  it('rewrites the whole index entry when the bucket changes, with no Delete', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity({ schedule }), previous.updatedAt, { previous });

    expect(verbs()).toEqual(['Put', 'Put']);
    expect(sentItems()[1]?.Put?.Item).toMatchObject({
      pk: `USER#${ALICE}`,
      sk: `IDX#${ACT}`,
      gsi1pk: `U#${ALICE}#S`,
    });
  });

  /**
   * The failure the "not an update" half of the rule guards against: every attribute is
   * rebuilt from the activity, so a field the activity no longer has cannot survive on the
   * projection. Here the date is cleared and the entry must leave `#S` for `#N`.
   */
  it('rebuilds every attribute, so a cleared field cannot linger on the projection', async () => {
    const previous = activity({ schedule: { ...schedule, time: '19:00' } });
    await patchActivity(ALICE, activity(), previous.updatedAt, { previous });

    const entry = sentItems()[1]?.Put?.Item;
    expect(entry).toMatchObject({ gsi1pk: `U#${ALICE}#N` });
    expect(entry).not.toHaveProperty('time');
  });

  /**
   * An index entry exists for the owner **and every participating app user** — that is how a
   * shared plan reaches somebody else's Today. Phase 6 supplies more than one; the shape is
   * here so it does not need retrofitting.
   */
  it('rewrites every indexed user’s entry, not only the owner’s', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity({ schedule }), previous.updatedAt, {
      previous,
      indexedUserIds: [ALICE, 'usr_b'],
    });

    const puts = sentItems()
      .map((entry) => entry.Put?.Item)
      .filter((item) => (item?.sk as string)?.startsWith('IDX#'));

    expect(puts.map((item) => item?.pk)).toEqual([`USER#${ALICE}`, 'USER#usr_b']);
  });
});
