import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { MAX_AUTOMATIC_INTENT_AGE_DAYS, MAX_PREP_TASKS_PER_PLAN } from '@od/shared';
import type { Activity } from '@od/shared/types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearListProvenance,
  createActivity,
  deleteActivity,
  detachChildFromParent,
  ingredientsAddedToListItem,
  listOverdueTaskCandidates,
  listPrepTaskPointers,
  localDateTime,
  markActivityDeleting,
  newActivityId,
  newReminderId,
  patchActivity,
  touchLastActivity,
  writeSchedule,
} from './activityRepository.js';
import type { TransactItem } from './tx.js';

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
    lastActivityAt: '2026-08-08T10:00:00.000Z',
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
  ddbMock.on(BatchWriteCommand).resolves({});
});

describe('delete ordering', () => {
  it('removes child/index rows before META so an interrupted delete stays authorisable', async () => {
    await deleteActivity(ALICE, ACT, {
      partition: [
        { pk: `ACT#${ACT}`, sk: 'META', entity: 'Activity', schemaVersion: 1 },
        {
          pk: `ACT#${ACT}`,
          sk: 'SUB#act_child',
          entity: 'ChildPointer',
          schemaVersion: 1,
        },
        {
          pk: `ACT#${ACT}`,
          sk: `REM#${ALICE}#rem_1`,
          entity: 'Reminder',
          schemaVersion: 1,
        },
      ],
    });

    const calls = ddbMock.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(1);
    const firstRequests = Object.values(calls[0]?.args[0]?.input.RequestItems ?? {})[0];
    const firstKeys = firstRequests?.map((request) => request.DeleteRequest?.Key);

    expect(firstKeys).toEqual(
      expect.arrayContaining([
        { pk: `ACT#${ACT}`, sk: 'SUB#act_child' },
        { pk: `ACT#${ACT}`, sk: `REM#${ALICE}#rem_1` },
        { pk: `USER#${ALICE}`, sk: `IDX#${ACT}` },
      ]),
    );
    expect(firstKeys).not.toContainEqual({ pk: `ACT#${ACT}`, sk: 'META' });

    /**
     * META's delete moved from a second batch into a transaction with the tombstone's put
     * (P2-49). The ordering property is unchanged — children and pointers still go first, so
     * an interrupted delete stays authorisable — but META's removal and the tombstone's
     * arrival are now atomic, leaving no window in which a replayed create finds neither.
     */
    const verbsSent = verbs();
    expect(verbsSent).toEqual(['Delete', 'Put']);
    expect(sentItems()[0]?.Delete?.Key).toEqual({ pk: `ACT#${ACT}`, sk: 'META' });
  });

  it('writes a tombstone whose TTL is bounded by the shared replay window', async () => {
    const deletedAt = '2026-08-17T10:00:00.000Z';
    await deleteActivity(ALICE, ACT, { partition: [], now: deletedAt });

    /**
     * The **same** constant that bounds the client's automatic replay, imported rather than
     * restated, so a tombstone always outlives every intent still eligible to replay against
     * it. DynamoDB's lazy TTL deletion is slack on top, never the margin.
     */
    expect(sentItems()[1]?.Put?.Item).toMatchObject({
      pk: `ACT#${ACT}`,
      sk: 'TOMBSTONE',
      entity: 'ActivityTombstone',
      ownerId: ALICE,
      deletedAt,
      ttl:
        Math.floor(Date.parse(deletedAt) / 1000) +
        MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60,
    });
  });
});

describe('activity deletion fence', () => {
  it('marks META before a partition snapshot can race a new attachment link', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markActivityDeleting(ALICE, ACT, '2026-08-26T12:00:00.000Z');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'META' },
      UpdateExpression: 'SET #deletingAt = if_not_exists(#deletingAt, :now)',
      ConditionExpression: 'attribute_exists(pk) AND #ownerId = :userId',
      ExpressionAttributeValues: {
        ':now': '2026-08-26T12:00:00.000Z',
        ':userId': ALICE,
      },
    });
  });
});

const sentItems = () =>
  (ddbMock.commandCalls(TransactWriteCommand).at(-1)?.args[0]?.input.TransactItems ??
    []) as Array<
    Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> }>
  >;

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

describe('touchLastActivity transaction composition', () => {
  const touchedAt = '2026-08-09T15:30:00.000Z';

  it.each([
    [
      'S',
      activity({ schedule: { ...schedule, time: '19:30' } }),
      `U#${ALICE}#S`,
      `2026-08-15T19:30#${ACT}`,
    ],
    ['P', plan(), `U#${ALICE}#P`, `${touchedAt}#${ACT}`],
    ['N', activity(), `U#${ALICE}#N`, `2026-08-08T10:00:00.000Z#${ACT}`],
    ['R', activity({ recurrence: series }), `U#${ALICE}#R`, `2026-08-01#${ACT}`],
  ])(
    'updates projected lastActivityAt while preserving the #%s bucket key rule',
    (_bucket, subject, expectedPk, expectedSk) => {
      const tx: TransactItem[] = [];

      const touched = touchLastActivity(subject, touchedAt, [ALICE], tx);
      const meta = tx[0]?.Update;
      const index = tx[1]?.Put?.Item;

      expect(touched).toMatchObject({
        lastActivityAt: touchedAt,
        updatedAt: subject.updatedAt,
      });
      expect(meta).toMatchObject({
        Key: { pk: `ACT#${ACT}`, sk: 'META' },
        UpdateExpression: 'SET #lastActivityAt = :at',
        ConditionExpression:
          '#updatedAt = :expected AND #lastActivityAt = :expectedLast AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeValues: {
          ':at': touchedAt,
          ':expected': subject.updatedAt,
          ':expectedLast': subject.lastActivityAt,
        },
      });
      expect(index).toMatchObject({
        entity: 'ActivityIndex',
        lastActivityAt: touchedAt,
        gsi1pk: expectedPk,
        gsi1sk: expectedSk,
      });
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    },
  );

  it('writes one index per distinct caller-supplied owner/participant id', () => {
    const tx: TransactItem[] = [];

    touchLastActivity(activity(), touchedAt, [ALICE, 'usr_ben', ALICE], tx);

    expect(tx).toHaveLength(3);
    expect(tx.slice(1).map((item) => item.Put?.Item?.pk)).toEqual([
      `USER#${ALICE}`,
      'USER#usr_ben',
    ]);
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
      timezone: 'America/New_York',
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
  it('writes META and the owner’s index entry, guarded against a taken id', async () => {
    await createActivity(ALICE, activity());

    // The `ConditionCheck` is the tombstone guard, between the two puts (Phase 2.6).
    expect(verbs()).toEqual(['Put', 'ConditionCheck', 'Put']);
    expect(sentItems()[0]?.Put).toMatchObject({
      Item: {
        pk: `ACT#${ACT}`,
        sk: 'META',
        entity: 'Activity',
        schemaVersion: 1,
      },
      /**
       * Unconditional before P2-49. A replayed client-minted create would have overwritten
       * whatever already lived at that id with the replayer's body.
       */
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('condition-checks the tombstone in the same transaction as the write', async () => {
    await createActivity(ALICE, activity());

    /**
     * Same transaction, not a read before it: a delete landing between a separate check and
     * the put would let a queued create resurrect a deleted activity.
     */
    expect(sentItems()[1]?.ConditionCheck).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'TOMBSTONE' },
      ConditionExpression: 'attribute_not_exists(pk)',
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
      restoredStatus: 'saved',
    });
  });

  it('writes no pointer when there is no parent', async () => {
    await createActivity(ALICE, activity());
    expect(sentItems().some((e) => (e.Put?.Item?.sk as string)?.startsWith('SUB#'))).toBe(
      false,
    );
  });

  it('marks pending attachments confirming in the same transaction as META', async () => {
    await createActivity(ALICE, activity(), {
      confirmAttachmentIds: ['att_01J8XKQ2M4N5P6R7S8T9V0W1X3'],
    });

    expect(sentItems().at(-1)?.Update).toMatchObject({
      Key: {
        pk: `USER#${ALICE}`,
        sk: 'UPLOAD#att_01J8XKQ2M4N5P6R7S8T9V0W1X3',
      },
      UpdateExpression: 'SET #state = :confirming, #activityId = :activityId',
      ConditionExpression: expect.stringContaining('#state = :awaiting'),
    });
  });
});

describe('patch', () => {
  it('pins the edit token and independently maintained META fields', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity({ title: 'Buy oat milk' }), previous.updatedAt, {
      previous,
    });

    expect(sentItems()[0]?.Put).toMatchObject({
      ConditionExpression:
        '#updatedAt = :expected AND #lastActivityAt = :expectedLastActivityAt AND #participantCount = :expectedParticipantCount AND #childCount = :expectedChildCount AND #expenseTotalCents = :expectedExpenseTotalCents AND attribute_not_exists(#deletingAt)',
      ExpressionAttributeValues: {
        ':expected': previous.updatedAt,
        ':expectedLastActivityAt': previous.lastActivityAt,
        ':expectedParticipantCount': previous.participantCount,
        ':expectedChildCount': previous.childCount,
        ':expectedExpenseTotalCents': previous.expenseTotalCents,
      },
    });
  });

  it('condition-checks a selected cover row in the same transaction', async () => {
    const previous = activity();
    await patchActivity(
      ALICE,
      activity({ primaryAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X3' }),
      previous.updatedAt,
      {
        previous,
        coverAttachmentId: 'att_01J8XKQ2M4N5P6R7S8T9V0W1X3',
      },
    );

    expect(sentItems()[1]?.ConditionCheck).toMatchObject({
      Key: {
        pk: `ACT#${ACT}`,
        sk: 'ATT#att_01J8XKQ2M4N5P6R7S8T9V0W1X3',
      },
      ConditionExpression: 'attribute_exists(pk)',
    });
  });

  it('guards a same-day recurrence correction against stored occurrence history', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity(), previous.updatedAt, {
      previous,
      requireMissingOccurrenceDate: '2026-08-12',
    });

    expect(sentItems().at(-1)?.ConditionCheck).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'OCC#2026-08-12' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('condition-checks the selected occurrence version during atomic conversion', async () => {
    const previous = activity();
    await patchActivity(ALICE, activity(), previous.updatedAt, {
      previous,
      occurrenceGuard: {
        date: '2026-08-12',
        kind: 'version',
        updatedAt: '2026-08-12T10:00:00.000Z',
      },
    });

    expect(sentItems().at(-1)?.ConditionCheck).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'OCC#2026-08-12' },
      ConditionExpression: '#updatedAt = :expected',
      ExpressionAttributeValues: { ':expected': '2026-08-12T10:00:00.000Z' },
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

  it('repairs the parent SUB pointer in the same transaction as a child title change', async () => {
    const parentActivityId = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
    const previous = activity({ parentActivityId });
    await patchActivity(
      ALICE,
      activity({ parentActivityId, title: 'Buy oat milk' }),
      previous.updatedAt,
      { previous, taskSubtitle: 'Breakfast', updateChildPointer: true },
    );

    expect(verbs()).toEqual(['Put', 'Put', 'Update']);
    expect(sentItems()[2]?.Update).toMatchObject({
      Key: { pk: `ACT#${parentActivityId}`, sk: `SUB#${ACT}` },
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':title': 'Buy oat milk',
        ':status': 'saved',
        ':restoredStatus': 'saved',
      },
    });
  });
});

describe('schedule transaction composition', () => {
  const receipt = {
    userId: ALICE,
    key: '11111111-1111-4111-8111-111111111111',
    route: 'POST /v1/activities/:id/schedule',
    status: 200,
    body: '{"data":{}}',
    ttl: 1,
    createdAt: '2026-08-11T12:00:00.000Z',
  };

  it('writes META, every index, RSVP rows, parent status and receipt together', async () => {
    const previous = activity({ parentActivityId: 'act_parent' });
    const next = activity({
      parentActivityId: 'act_parent',
      status: 'scheduled',
      schedule,
      updatedAt: '2026-08-11T12:00:00.000Z',
    });
    await writeSchedule(next, {
      previous,
      indexedUserIds: [ALICE, 'usr_b'],
      participantRows: [
        { pk: `ACT#${ACT}`, sk: 'PART#psn_b', entity: 'Participant', rsvp: 'pending' },
      ],
      idempotencyReceipt: receipt,
    });

    const items = sentItems();
    expect(items.filter((entry) => entry.Put?.Item?.entity === 'Activity')).toHaveLength(
      1,
    );
    expect(
      items.filter((entry) => entry.Put?.Item?.entity === 'ActivityIndex'),
    ).toHaveLength(2);
    expect(
      items.filter((entry) => entry.Put?.Item?.entity === 'Participant'),
    ).toHaveLength(1);
    expect(
      items.filter((entry) => entry.Put?.Item?.entity === 'Idempotency'),
    ).toHaveLength(1);
    expect(items.some((entry) => 'Update' in entry)).toBe(true);
  });

  it('commits durable cleanup in the same transaction as the receipt', async () => {
    const previous = activity({ status: 'scheduled', schedule });
    await writeSchedule(activity(), {
      previous,
      indexedUserIds: [ALICE],
      idempotencyReceipt: {
        ...receipt,
        cleanupRef: { activityId: ACT, userId: ALICE, idempotencyKey: receipt.key },
      },
      cleanupWork: {
        activityId: ACT,
        userId: ALICE,
        idempotencyKey: receipt.key,
        phases: [{ kind: 'delete_reminders', complete: false }],
        createdAt: receipt.createdAt,
        updatedAt: receipt.createdAt,
        schemaVersion: 1,
      },
    });

    expect(
      sentItems().filter((entry) => entry.Put?.Item?.entity === 'CleanupWork'),
    ).toHaveLength(1);
    expect(
      sentItems().filter((entry) => entry.Put?.Item?.entity === 'Idempotency'),
    ).toHaveLength(1);
  });
});

describe('overdue task window', () => {
  it('queries only the bounded #S range and retains exactly eligible index rows', async () => {
    const eligible = {
      activityId: ACT,
      type: 'task',
      status: 'scheduled',
      isRecurring: false,
    };
    ddbMock.on(QueryCommand).resolves({
      Items: [
        eligible,
        { ...eligible, activityId: 'act_event', type: 'event' },
        { ...eligible, activityId: 'act_done', status: 'completed' },
        { ...eligible, activityId: 'act_series', isRecurring: true },
      ],
    });

    await expect(
      listOverdueTaskCandidates(ALICE, '2026-07-07', '2026-08-05'),
    ).resolves.toEqual([
      eligible,
      { ...eligible, activityId: 'act_done', status: 'completed' },
    ]);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input).toMatchObject({
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': `U#${ALICE}#S`,
        ':from': '2026-07-07T00:00',
        ':to': '2026-08-05T23:59',
      },
    });
  });
});

/**
 * The `addedToListId` write-back (P3-17).
 *
 * DynamoDB addresses a list element by position, and position is the one thing about an
 * ingredient array that is not stable. These assertions are about the seam that makes that
 * safe: the caller resolves ids to indexes, and every index carries a condition that the id
 * still sitting there is the one that was resolved.
 */
describe('ingredientsAddedToListItem', () => {
  const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
  const CHICKEN = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
  const TORTILLAS = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';
  const READ_AT = '2026-08-25T09:00:00.000Z';
  const NOW_AT = '2026-08-25T09:00:01.000Z';

  const built = (
    additions = [
      { index: 0, ingredientId: CHICKEN },
      { index: 3, ingredientId: TORTILLAS },
    ],
  ) => ingredientsAddedToListItem(ACT, LIST, additions, READ_AT, NOW_AT).Update;

  it('sets the flag at each resolved index', () => {
    expect(built()?.UpdateExpression).toContain(
      '#details.#ingredients[0].#addedToListId = :listId',
    );
    expect(built()?.UpdateExpression).toContain(
      '#details.#ingredients[3].#addedToListId = :listId',
    );
    expect(built()?.ExpressionAttributeValues).toMatchObject({ ':listId': LIST });
  });

  /** A reorder between the read and the commit must fail, not mark a neighbour. */
  it('conditions every index on the id that was resolved there', () => {
    expect(built()?.ConditionExpression).toContain(
      '#details.#ingredients[0].#ingredientId = :id0',
    );
    expect(built()?.ConditionExpression).toContain(
      '#details.#ingredients[3].#ingredientId = :id3',
    );
    expect(built()?.ExpressionAttributeValues).toMatchObject({
      ':id0': CHICKEN,
      ':id3': TORTILLAS,
    });
  });

  /**
   * The `updatedAt` correction (raised in review). `addedToListId` is rendered — it is what
   * makes an ingredient row say `Added` — and it lives inside `details`, which `PATCH`
   * replaces wholesale under `If-Match`. A field that changes what the user sees, on a
   * versioned object, has to move the version.
   */
  it('advances updatedAt', () => {
    expect(built()?.UpdateExpression).toContain('#updatedAt = :updatedAt');
    expect(built()?.ExpressionAttributeValues).toMatchObject({ ':updatedAt': NOW_AT });
  });

  /** And conditions on the version it read, so a patch landing in between wins. */
  it('conditions on the version the caller read', () => {
    expect(built()?.ConditionExpression).toContain('#updatedAt = :expectedUpdatedAt');
    expect(built()?.ExpressionAttributeValues).toMatchObject({
      ':expectedUpdatedAt': READ_AT,
    });
  });

  it('requires the activity to still exist', () => {
    expect(built()?.ConditionExpression).toContain('attribute_exists(pk)');
  });
});

describe('clearListProvenance', () => {
  const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';
  const CLEARED_AT = '2026-08-25T09:00:02.000Z';

  it('removes only matching provenance and advances the Activity version', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await clearListProvenance(ACT, LIST, CLEARED_AT);

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'META' },
      UpdateExpression: 'SET #updatedAt = :updatedAt REMOVE #listId, #listItemId',
      ConditionExpression: 'attribute_exists(pk) AND #listId = :listId',
      ExpressionAttributeValues: {
        ':listId': LIST,
        ':updatedAt': CLEARED_AT,
      },
    });
  });

  it('remains idempotent when the Activity no longer points at that list', async () => {
    const stale = Object.assign(new Error('stale provenance'), {
      name: 'ConditionalCheckFailedException',
    });
    ddbMock.on(UpdateCommand).rejects(stale);

    await expect(clearListProvenance(ACT, LIST, CLEARED_AT)).resolves.toBeUndefined();
  });
});

/**
 * The parent side of a prep task (P3-18).
 *
 * Everything here is about one invariant: **the pointer, the count and the child never
 * disagree**, because the plan's `3 of 5 done` is a number the user is invited to tap. So the
 * pointer moves in the same transaction as the child, the count moves with the pointer, and
 * the cap is a condition on the count rather than a hope about it.
 */
describe('prep-task pointer and parent counter', () => {
  const PARENT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
  const OTHER_PARENT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';

  /** Typed as transact items, so conditions and expressions are reachable, not just keys. */
  const items = () =>
    (ddbMock.commandCalls(TransactWriteCommand).at(-1)?.args[0]?.input.TransactItems ??
      []) as TransactItem[];

  const counterFor = (parentActivityId: string) =>
    items().find(
      (entry) =>
        entry.Update?.Key?.pk === `ACT#${parentActivityId}` &&
        entry.Update?.Key?.sk === 'META',
    )?.Update;

  const pointerPutFor = (parentActivityId: string) =>
    items().find((entry) => entry.Put?.Item?.pk === `ACT#${parentActivityId}`)?.Put?.Item;

  it('writes the pointer and increments the parent, in the create transaction', async () => {
    await createActivity(ALICE, activity({ parentActivityId: PARENT }));

    expect(pointerPutFor(PARENT)).toMatchObject({
      sk: `SUB#${ACT}`,
      entity: 'ChildPointer',
      childActivityId: ACT,
      title: 'Buy milk',
      status: 'saved',
      restoredStatus: 'saved',
      isRecurring: false,
    });
    expect(counterFor(PARENT)).toMatchObject({
      UpdateExpression: 'ADD #childCount :delta',
      ExpressionAttributeValues: { ':delta': 1, ':cap': 50 },
    });
  });

  /**
   * The cap is enforced **here**, not only in the service that read `childCount` first. A
   * precheck cannot see the create that commits between its read and its write; a condition
   * on the counter itself refuses the 51st whatever else is in flight.
   */
  it('conditions the increment on the parent existing and being under the cap', async () => {
    await createActivity(ALICE, activity({ parentActivityId: PARENT }));

    expect(counterFor(PARENT)?.ConditionExpression).toBe(
      'attribute_exists(pk) AND #childCount < :cap AND #objectKind = :plan AND attribute_not_exists(#deletingAt)',
    );
    expect(counterFor(PARENT)?.ExpressionAttributeNames).toMatchObject({
      '#deletingAt': 'deletingAt',
    });
  });

  /**
   * The kind term is half of a pair: the Plan → Task conversion pins the `childCount` it
   * validated, and this pins the `objectKind` it read. `updatedAt` cannot mediate between
   * them, because the counter moves by `ADD` and deliberately does not advance it.
   */
  it('conditions the increment on the parent still being a plan', async () => {
    await createActivity(ALICE, activity({ parentActivityId: PARENT }));

    const counter = counterFor(PARENT);
    expect(counter?.ExpressionAttributeValues).toMatchObject({ ':plan': 'plan' });
    expect(counter?.ExpressionAttributeNames).toMatchObject({
      '#objectKind': 'objectKind',
    });
  });

  /** A child must always be able to clean up after itself, whatever the parent became. */
  it('does not gate the decrement on the parent being a plan', async () => {
    await detachChildFromParent(PARENT, 'act_01J8XKQ2M4N5P6R7S8T9V0W1XB');

    expect(counterFor(PARENT)?.ConditionExpression).toBe(
      'attribute_exists(pk) AND #childCount > :zero',
    );
  });

  /**
   * A denormalised count of other rows is not an edit to the plan. Bumping `updatedAt` would
   * conflict an unrelated `If-Match` edit of the plan itself every time somebody added a prep
   * task, and `IndexProjection` carries no `childCount`, so no index entry moves either.
   */
  it('leaves the parent updatedAt alone — the counter is not an edit', async () => {
    await createActivity(ALICE, activity({ parentActivityId: PARENT }));

    const counter = counterFor(PARENT);
    expect(counter?.UpdateExpression).not.toContain('updatedAt');
    expect(counter?.ExpressionAttributeNames).not.toHaveProperty('#updatedAt');
  });

  /** The two facts native completion must never infer from a terminal status. */
  it('records recurrence and schedule-derived restoration state on the pointer', async () => {
    await createActivity(
      ALICE,
      activity({ parentActivityId: PARENT, schedule, recurrence: series }),
    );

    expect(pointerPutFor(PARENT)).toMatchObject({
      isRecurring: true,
      restoredStatus: 'scheduled',
    });
  });

  it('refreshes title, status and the recurrence bit on the unchanged parent', async () => {
    const previous = activity({ parentActivityId: PARENT, schedule, recurrence: series });
    await patchActivity(
      ALICE,
      activity({ parentActivityId: PARENT, schedule, title: 'Buy oat milk' }),
      previous.updatedAt,
      { previous, taskSubtitle: 'Trip', updateChildPointer: true },
    );

    expect(counterFor(PARENT)).toBeUndefined();
    expect(items().at(-1)?.Update).toMatchObject({
      Key: { pk: `ACT#${PARENT}`, sk: `SUB#${ACT}` },
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':title': 'Buy oat milk',
        ':status': 'saved',
        ':restoredStatus': 'scheduled',
        ':isRecurring': false,
      },
    });
  });

  it('moves the pointer and both counters when the parent changes', async () => {
    const previous = activity({ parentActivityId: PARENT });
    await patchActivity(
      ALICE,
      activity({ parentActivityId: OTHER_PARENT }),
      previous.updatedAt,
      { previous, taskSubtitle: 'Other trip', updateChildPointer: true },
    );

    expect(
      items().find((entry) => entry.Delete?.Key?.pk === `ACT#${PARENT}`)?.Delete,
    ).toMatchObject({
      Key: { sk: `SUB#${ACT}` },
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(counterFor(PARENT)?.ExpressionAttributeValues).toMatchObject({ ':delta': -1 });
    expect(pointerPutFor(OTHER_PARENT)).toMatchObject({ sk: `SUB#${ACT}` });
    expect(counterFor(OTHER_PARENT)?.ExpressionAttributeValues).toMatchObject({
      ':delta': 1,
    });
  });

  it('removes the pointer and decrements when the parent is cleared', async () => {
    const previous = activity({ parentActivityId: PARENT });
    await patchActivity(ALICE, activity(), previous.updatedAt, {
      previous,
      updateChildPointer: true,
    });

    expect(items().some((entry) => entry.Delete?.Key?.pk === `ACT#${PARENT}`)).toBe(true);
    expect(counterFor(PARENT)).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #childCount > :zero',
      ExpressionAttributeValues: { ':delta': -1, ':zero': 0 },
    });
  });

  /** The half of the delete cascade that lives in the *parent's* partition. */
  it('detaches a deleted child by removing the pointer and the count together', async () => {
    await detachChildFromParent(PARENT, ACT);

    expect(verbs()).toEqual(['Delete', 'Update']);
    expect(items()[0]?.Delete).toMatchObject({
      Key: { pk: `ACT#${PARENT}`, sk: `SUB#${ACT}` },
      ConditionExpression: 'attribute_exists(pk)',
    });
    expect(counterFor(PARENT)?.ExpressionAttributeValues).toMatchObject({ ':delta': -1 });
  });

  /**
   * A pointer that has already gone means the step already ran, or the parent went with it.
   * Raising would block the retry that finishes an interrupted cascade, and applying the
   * decrement twice would leave the plan claiming fewer children than it has.
   */
  it('treats an already-removed pointer as done rather than as a failure', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'cancelled',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );

    await expect(detachChildFromParent(PARENT, ACT)).resolves.toBeUndefined();
  });
});

/**
 * Access pattern 16, and the reason it can be one page: creation refuses the 51st child, so
 * `Limit` at the model cap **is** the complete collection — no cursor, no second read, and
 * never the GSI alternative the data model names and rejects.
 */
describe('listPrepTaskPointers', () => {
  const PARENT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

  it('reads one bounded, strongly consistent page of the child prefix', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await listPrepTaskPointers(PARENT);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0]?.input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
      ExpressionAttributeValues: { ':pk': `ACT#${PARENT}`, ':skPrefix': 'SUB#' },
      Limit: MAX_PREP_TASKS_PER_PLAN,
      ConsistentRead: true,
    });
  });

  /**
   * Pointers written before this task carry no `isRecurring`. Absent has to read as `false`:
   * treating it as `true` would drop a real one-off child out of the follow-up's count and
   * out of its bulk actions.
   */
  it('projects the pointer, reading an absent recurrence bit as false', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          pk: `ACT#${PARENT}`,
          sk: `SUB#${ACT}`,
          entity: 'ChildPointer',
          childActivityId: ACT,
          title: 'Book hotel',
          status: 'completed',
          restoredStatus: 'saved',
          rank: '2026-08-08T10:00:00.000Z',
          schemaVersion: 1,
        },
      ],
    });

    await expect(listPrepTaskPointers(PARENT)).resolves.toEqual([
      {
        childActivityId: ACT,
        title: 'Book hotel',
        status: 'completed',
        restoredStatus: 'saved',
        rank: '2026-08-08T10:00:00.000Z',
        isRecurring: false,
      },
    ]);
  });
});
