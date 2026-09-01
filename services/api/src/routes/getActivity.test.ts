import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/**
 * `GET /v1/activities/:id` (P1-12).
 *
 * Its own file rather than an addition to `activities.test.ts`: that suite mocks
 * `TransactWriteCommand` for the create path, and a read test failing inside it would read as
 * a create regression.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

const DEV = 'usr_local_dev';
const OTHER = 'usr_someone_else';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1L1';

const REMINDER_OF = {
  [DEV]: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
  [OTHER]: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1BB',
} as const;

const meta = (overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId: DEV,
  status: 'saved',
  objectKind: 'plan',
  type: 'event',
  title: 'Dinner',
  details: { kind: 'event' },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  lastActivityAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

const reminderOf = (userId: keyof typeof REMINDER_OF, offsetMinutes: number) => ({
  pk: `ACT#${ACT}`,
  sk: `REM#${userId}#${REMINDER_OF[userId]}`,
  entity: 'Reminder',
  reminderId: REMINDER_OF[userId],
  activityId: ACT,
  userId,
  offsetMinutes,
  channel: 'push',
  schemaVersion: 1,
});

/** Seeds the exact strong META/index/occurrence reads and every bounded prefix collection. */
const seed = (
  partition: Record<string, unknown>[],
  updates: Record<string, unknown>[] = [],
  attachments: Record<string, unknown>[] = [],
) => {
  ddbMock.on(GetCommand).callsFake((input) => {
    const key = input.Key as Record<string, unknown>;
    if (key.pk === `ACT#${ACT}` && key.sk === 'META') {
      return { Item: partition.find((row) => row.sk === 'META') as never };
    }
    if (key.pk === `ACT#${ACT}` && String(key.sk).startsWith('OCC#')) {
      return { Item: partition.find((row) => row.sk === key.sk) as never };
    }
    if (String(key.pk).startsWith('USER#') && key.sk === `IDX#${ACT}`) {
      const userId = String(key.pk).slice('USER#'.length);
      const granted = partition.some(
        (row) => row.entity === 'Participant' && row.userId === userId,
      );
      return granted
        ? { Item: { ...key, entity: 'ActivityIndex', activityId: ACT, userId } as never }
        : {};
    }
    return {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const prefix = String(values[':skPrefix'] ?? '');
    switch (prefix) {
      case 'UPD#':
        return { Items: updates as never };
      case 'ATT#':
        return { Items: attachments as never };
      case 'UPLOAD#':
        return { Items: [] as never };
      case 'OCC#':
        return {
          Count: partition.filter(
            (row) => String(row.sk).startsWith(prefix) && row.status === 'completed',
          ).length,
        };
      default:
        return {
          Items: partition.filter((row) => String(row.sk).startsWith(prefix)) as never,
        };
    }
  });
};

const participantOf = (userId: string) => ({
  pk: `ACT#${ACT}`,
  sk: 'PART#psn_01J8XKQ2M4N5P6R7S8T9V0W1XP',
  entity: 'Participant',
  activityId: ACT,
  personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1XP',
  userId,
  displayName: 'Participant',
  rsvp: 'going',
  role: 'participant',
  isGuest: false,
});

const sourceList = () => ({
  pk: `ACT#${ACT}`,
  sk: `SOURCE_LIST#${LIST}`,
  entity: 'SourceList',
  listId: LIST,
  schemaVersion: 1,
});

const privateListMeta = () => ({
  pk: `LIST#${LIST}`,
  sk: 'META',
  entity: 'List',
  listId: LIST,
  title: 'Owner private packing',
  icon: 'check-square',
  itemCount: 7,
  doneCount: 2,
  schemaVersion: 2,
});

const listPointer = (userId: string) => ({
  pk: `USER#${userId}`,
  sk: `LIST#${LIST}`,
  entity: 'ListIndex',
  userId,
  listId: LIST,
  schemaVersion: 2,
});

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const get = (app: ReturnType<typeof CreateApp>, id = ACT, occurrenceDate?: string) =>
  app.fetch(
    new Request(
      `http://localhost/v1/activities/${id}${
        occurrenceDate === undefined ? '' : `?occurrenceDate=${occurrenceDate}`
      }`,
    ),
  );

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

describe('reading an activity you own', () => {
  it('returns the activity and the caller’s reminders', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.activity.activityId).toBe(ACT);
    expect(body.data.activity.title).toBe('Dinner');
    expect(body.data.reminders).toHaveLength(1);
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  /**
   * Named collections, not a bare activity — so Phase 6 adds `participants` without changing
   * the envelope a Phase 1 client was written against (`api-contract.md` §2.3).
   */
  it('answers with named collections rather than the activity itself', async () => {
    seed([meta()]);

    const body = await (await get(createApp())).json();

    /**
     * The whole point of the envelope: each collection is **added** as its phase lands, so a
     * client written against Phase 1 keeps working. `updates` is P3-19's addition,
     * `attachments` is P3-22's, and `children` and `sourceLists` are P3-37's — the two
     * remaining collections the one-request rule composes from the partition read.
     */
    expect(Object.keys(body.data).sort()).toEqual([
      'activity',
      'attachments',
      'capabilities',
      'children',
      'completedOccurrenceCount',
      'reminders',
      'sourceLists',
      'updates',
    ]);
  });

  it('returns the real stored completion count without another round trip', async () => {
    seed([
      meta(),
      {
        pk: `ACT#${ACT}`,
        sk: 'OCC#2026-08-01',
        entity: 'Occurrence',
        status: 'completed',
      },
      { pk: `ACT#${ACT}`, sk: 'OCC#2026-08-02', entity: 'Occurrence', status: 'skipped' },
    ]);

    const body = await (await get(createApp())).json();

    expect(body.data.completedOccurrenceCount).toBe(1);
    /**
     * Seven fixed reads: updates, caller reminders, Prep pointers, source-List pointers,
     * occurrence count, pending uploads and attachments. None grows with partition size.
     */
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(7);
  });

  it('returns an empty reminders array when there are none', async () => {
    seed([meta()]);

    const body = await (await get(createApp())).json();

    expect(body.data.reminders).toEqual([]);
    expect(body.data.capabilities).toEqual({
      complete: true,
      skip: true,
      snooze: true,
    });
  });

  it('never leaks the storage attributes', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    const body = await (await get(createApp())).json();

    for (const shape of [body.data.activity, body.data.reminders[0]]) {
      expect(shape).not.toHaveProperty('pk');
      expect(shape).not.toHaveProperty('sk');
      expect(shape).not.toHaveProperty('entity');
    }
  });

  it('returns a body the shared detail schema accepts', async () => {
    const { activityDetail } = await import('@od/shared/schemas');
    seed([meta(), reminderOf(DEV, -15)]);

    const body = await (await get(createApp())).json();

    expect(activityDetail.safeParse(body.data).success).toBe(true);
  });

  it('coalesces legacy child restoration and source-List hydration into one strong batch', async () => {
    const savedChild = 'act_01J8XKQ2M4N5P6R7S8T9V0W1C1';
    const datedChild = 'act_01J8XKQ2M4N5P6R7S8T9V0W1C2';
    const pointer = (childActivityId: string, title: string, rank: string) => ({
      pk: `ACT#${ACT}`,
      sk: `SUB#${childActivityId}`,
      entity: 'ChildPointer',
      childActivityId,
      title,
      status: 'completed',
      rank,
      schemaVersion: 1,
    });
    const childMeta = (activityId: string, title: string, dated: boolean) => ({
      ...meta({
        activityId,
        objectKind: 'task',
        type: 'task',
        title,
        status: 'completed',
        details: { kind: 'task' },
        ...(dated
          ? { schedule: { date: '2026-08-20', timezone: 'America/New_York' } }
          : {}),
      }),
      pk: `ACT#${activityId}`,
    });
    seed([
      meta(),
      pointer(savedChild, 'Saved child', 'a'),
      pointer(datedChild, 'Dated child', 'b'),
      sourceList(),
    ]);
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        'od-main-local': [
          childMeta(savedChild, 'Saved child', false),
          childMeta(datedChild, 'Dated child', true),
          privateListMeta(),
          listPointer(DEV),
        ] as never,
      },
    });

    const body = await (await get(createApp())).json();

    expect(body.data.children).toEqual([
      expect.objectContaining({ activityId: savedChild, restoredStatus: 'saved' }),
      expect.objectContaining({ activityId: datedChild, restoredStatus: 'scheduled' }),
    ]);
    expect(body.data.sourceLists).toHaveLength(1);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(1);
    expect(
      ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[
        'od-main-local'
      ],
    ).toMatchObject({ ConsistentRead: true });
  });

  it('authorises from META and projects only bounded strong prefixes', async () => {
    seed([meta()]);

    await get(createApp());

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: `ACT#${ACT}`, sk: 'META' },
      ConsistentRead: true,
    });
    const queries = ddbMock.commandCalls(QueryCommand).map((call) => call.args[0].input);
    expect(queries).toHaveLength(7);
    expect(queries.every((input) => input.ConsistentRead === true)).toBe(true);
    expect(
      queries.every(
        (input) =>
          (input.ExpressionAttributeValues as Record<string, unknown>)[':skPrefix'] !==
          undefined,
      ),
    ).toBe(true);
    expect(
      queries
        .filter((input) => input.Select !== 'COUNT')
        .every((input) => typeof input.Limit === 'number'),
    ).toBe(true);
  });

  it('uses exactly three dependency waves for a direct participant with hydration', async () => {
    const partition = [meta({ ownerId: OTHER }), participantOf(DEV), sourceList()];
    const authorityWave = deferred<void>();
    const sectionWave = deferred<void>();
    const hydrationWave = deferred<void>();
    ddbMock.on(GetCommand).callsFake(async (input) => {
      const key = input.Key as Record<string, unknown>;
      await authorityWave.promise;
      if (key.pk === `ACT#${ACT}` && key.sk === 'META') {
        return { Item: partition[0] as never };
      }
      return {
        Item: {
          ...key,
          entity: 'ActivityIndex',
          activityId: ACT,
          userId: DEV,
        } as never,
      };
    });
    ddbMock.on(QueryCommand).callsFake(async (input) => {
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const prefix = String(values[':skPrefix'] ?? '');
      if (prefix === 'ATT#') {
        await hydrationWave.promise;
        return { Items: [] };
      }
      await sectionWave.promise;
      if (prefix === 'OCC#') return { Count: 0 };
      return {
        Items: partition.filter((row) => String(row.sk).startsWith(prefix)) as never,
      };
    });
    ddbMock.on(BatchGetCommand).callsFake(async () => {
      await hydrationWave.promise;
      return {
        Responses: {
          'od-main-local': [privateListMeta(), listPointer(DEV)] as never,
        },
      };
    });

    const response = get(asUser(DEV));
    await vi.waitFor(() => expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2));
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);

    authorityWave.resolve();
    await vi.waitFor(() => expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(6));
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);

    sectionWave.resolve();
    await vi.waitFor(() => expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(7));
    await vi.waitFor(() => expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(1));

    hydrationWave.resolve();
    await expect(response).resolves.toMatchObject({ status: 200 });
  });

  it('measures the maximum bounded command set and occurrence-count continuation', async () => {
    const idToken = (index: number) =>
      `01J8XKQ2M4N5P6R7S8T9V0${String(index).padStart(4, '0')}`;
    const listIds = Array.from({ length: 100 }, (_, index) => `lst_${idToken(index)}`);
    const childIds = Array.from(
      { length: 50 },
      (_, index) => `act_${idToken(index + 100)}`,
    );
    const sourceRows = listIds.map((listId) => ({
      pk: `ACT#${ACT}`,
      sk: `SOURCE_LIST#${listId}`,
      entity: 'SourceList',
      listId,
      schemaVersion: 1,
    }));
    const childRows = childIds.map((childActivityId, index) => ({
      pk: `ACT#${ACT}`,
      sk: `SUB#${childActivityId}`,
      entity: 'ChildPointer',
      childActivityId,
      title: `Child ${index}`,
      status: 'completed',
      rank: String(index).padStart(3, '0'),
      isRecurring: false,
    }));
    const attachments = Array.from({ length: 20 }, (_, index) => {
      const attachmentId = `att_${idToken(index + 200)}`;
      return {
        pk: `ACT#${ACT}`,
        sk: `ATT#${attachmentId}`,
        entity: 'Attachment',
        attachmentId,
        activityId: ACT,
        key: `u/${DEV}/${attachmentId}.jpg`,
        contentType: 'image/jpeg',
        byteSize: 2_048,
        createdAt: `2026-08-26T12:${String(index).padStart(2, '0')}:00.000Z`,
        schemaVersion: 1,
      };
    });
    const partition = [meta(), ...sourceRows, ...childRows];
    seed(partition, [], attachments);
    ddbMock.on(QueryCommand).callsFake((input) => {
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      const prefix = String(values[':skPrefix'] ?? '');
      if (prefix === 'UPD#') return { Items: [] };
      if (prefix === 'ATT#') return { Items: attachments as never };
      if (prefix === 'UPLOAD#') return { Items: [] };
      if (prefix === 'OCC#') {
        return input.ExclusiveStartKey === undefined
          ? {
              Count: 1,
              LastEvaluatedKey: { pk: `ACT#${ACT}`, sk: 'OCC#continuation' },
            }
          : { Count: 1 };
      }
      return {
        Items: partition.filter((row) => String(row.sk).startsWith(prefix)) as never,
      };
    });
    const childMetaById = new Map(
      childIds.map((activityId) => [
        activityId,
        meta({
          pk: `ACT#${activityId}`,
          activityId,
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          status: 'completed',
        }),
      ]),
    );
    ddbMock.on(BatchGetCommand).callsFake((input) => {
      const keys = input.RequestItems?.['od-main-local']?.Keys ?? [];
      const rows = keys.flatMap((key: Record<string, unknown>) => {
        const pk = String(key.pk);
        const sk = String(key.sk);
        if (pk.startsWith('ACT#') && sk === 'META') {
          const child = childMetaById.get(pk.slice('ACT#'.length));
          return child === undefined ? [] : [child];
        }
        if (pk.startsWith('LIST#') && sk === 'META') {
          const listId = pk.slice('LIST#'.length);
          return [
            {
              pk,
              sk,
              entity: 'List',
              listId,
              title: `List ${listId}`,
              icon: 'list',
              itemCount: 0,
              doneCount: 0,
              schemaVersion: 2,
            },
          ];
        }
        if (pk === `USER#${DEV}` && sk.startsWith('LIST#')) {
          const listId = sk.slice('LIST#'.length);
          return [{ pk, sk, entity: 'ListIndex', userId: DEV, listId, schemaVersion: 2 }];
        }
        return [];
      });
      return { Responses: { 'od-main-local': rows as never } };
    });

    const response = await get(createApp());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      completedOccurrenceCount: 2,
      children: expect.any(Array),
      sourceLists: expect.any(Array),
      attachments: expect.any(Array),
    });
    expect(body.data.children).toHaveLength(50);
    expect(body.data.sourceLists).toHaveLength(100);
    expect(body.data.attachments).toHaveLength(20);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(8);
    const batches = ddbMock.commandCalls(BatchGetCommand);
    expect(batches).toHaveLength(3);
    expect(
      batches
        .map((call) => call.args[0].input.RequestItems?.['od-main-local']?.Keys?.length)
        .sort((left, right) => Number(left) - Number(right)),
    ).toEqual([50, 100, 100]);
  });
});

describe('an explicitly targeted recurring occurrence', () => {
  const DATE = '2026-08-14';
  const recurring = () =>
    meta({
      status: 'scheduled',
      schedule: {
        date: '2026-08-01',
        time: '09:00',
        endTime: '10:00',
        timezone: 'America/New_York',
      },
      recurrence: {
        mode: 'fixed',
        segments: [
          {
            freq: 'daily',
            interval: 1,
            effectiveFrom: '2026-08-01',
            time: '09:00',
            endTime: '10:00',
          },
        ],
      },
    });
  const occurrence = (overrides: Record<string, unknown>) => ({
    pk: `ACT#${ACT}`,
    sk: `OCC#${DATE}`,
    entity: 'Occurrence',
    activityId: ACT,
    date: DATE,
    ...overrides,
  });

  it('projects an untouched occurrence without requiring an agenda read', async () => {
    seed([recurring()]);

    const body = await (await get(createApp(), ACT, DATE)).json();

    expect(body.data.occurrence).toEqual({
      nominalDate: DATE,
      date: DATE,
      time: '09:00',
      endTime: '10:00',
      status: 'scheduled',
      isSnoozed: false,
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(7);
  });

  it('projects a moved occurrence from its nominal identity', async () => {
    seed([
      recurring(),
      occurrence({
        status: 'rescheduled',
        overrideDate: '2026-08-16',
        overrideTime: '18:30',
      }),
    ]);

    const body = await (await get(createApp(), ACT, DATE)).json();

    expect(body.data.occurrence).toMatchObject({
      nominalDate: DATE,
      date: '2026-08-16',
      time: '18:30',
      status: 'scheduled',
      isSnoozed: false,
    });
  });

  it('projects a cross-day snooze in the activity timezone', async () => {
    seed([
      recurring(),
      occurrence({ status: 'snoozed', snoozedUntil: '2026-08-16T00:30:00.000Z' }),
    ]);

    const body = await (await get(createApp(), ACT, DATE)).json();

    expect(body.data.occurrence).toMatchObject({
      nominalDate: DATE,
      date: '2026-08-15',
      time: '20:30',
      status: 'scheduled',
      isSnoozed: true,
    });
  });

  it('projects stored completion rather than the series status', async () => {
    seed([
      recurring(),
      occurrence({
        status: 'completed',
        completedAt: '2026-08-14T14:00:00.000Z',
      }),
    ]);

    const body = await (await get(createApp(), ACT, DATE)).json();

    expect(body.data.occurrence).toMatchObject({
      status: 'completed_occurrence',
      completedAt: '2026-08-14T14:00:00.000Z',
    });
  });

  it('rejects an occurrence query for a one-off instead of manufacturing a target', async () => {
    seed([meta()]);

    const res = await get(createApp(), ACT, DATE);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details).toContainEqual({
      path: 'occurrenceDate',
      message: 'The date is not emitted by this recurrence.',
    });
  });
});

/**
 * **The assertion this endpoint exists to get right.**
 *
 * Every participant's reminder rows live in the partition the single `Query` reads, so a
 * handler that returned what it read would hand one user another user's reminders — a leak
 * nobody would ever notice, because you cannot see what is missing from your own response
 * (`security-privacy.md` §1 row 15, ADR-047).
 */
describe('reminders are the caller’s own', () => {
  const shared = () => [meta(), reminderOf(DEV, -15), reminderOf(OTHER, -90)];

  it('returns only the caller’s reminder from a partition holding two', async () => {
    seed(shared());

    const body = await (await get(createApp())).json();

    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0]).toMatchObject({ userId: DEV, offsetMinutes: -15 });
  });

  /**
   * **No trace** — not the offset, not the id, not a count. Searched as a serialised string,
   * because a leak that survives an assertion on named fields is a leak through the field
   * nobody thought to name.
   */
  it('leaves no trace of the other user’s reminder anywhere in the response', async () => {
    seed(shared());

    const raw = await (await get(createApp())).text();

    expect(raw).not.toContain(OTHER);
    expect(raw).not.toContain('-90');
    expect(raw).not.toContain(REMINDER_OF[OTHER]);
  });

  /** Symmetric: the owner does not get special sight of anybody else's either. */
  it('is symmetric — the other user reading the same partition sees only theirs', async () => {
    seed([meta({ ownerId: OTHER }), reminderOf(DEV, -15), reminderOf(OTHER, -90)]);

    const raw = await (await get(asUser(OTHER))).text();
    const body = JSON.parse(raw);

    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0].userId).toBe(OTHER);
    expect(raw).not.toContain(REMINDER_OF[DEV]);
  });

  it('admits a direct participant but does not grant plan completion capabilities', async () => {
    seed([meta(), participantOf(OTHER), reminderOf(OTHER, -90)]);

    const body = await (await get(asUser(OTHER))).json();

    expect(body.data.reminders).toEqual([
      expect.objectContaining({ userId: OTHER, offsetMinutes: -90 }),
    ]);
    expect(body.data.capabilities).toEqual({
      complete: false,
      skip: false,
      snooze: false,
    });
  });

  it('does not reveal a sourced List to a Plan participant without List access', async () => {
    seed([
      meta({ visibility: 'shared', participantCount: 1 }),
      participantOf(OTHER),
      sourceList(),
    ]);
    // The List exists, but the batch deliberately contains no USER#<caller>/LIST#<list>
    // pointer. Plan participation and List membership are independent grants.
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'od-main-local': [privateListMeta()] as never },
    });

    const res = await get(asUser(OTHER));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.sourceLists).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('Owner private packing');
  });

  it('returns a sourced List when the caller has independent List access', async () => {
    seed([meta(), sourceList()]);
    // BatchGet ordering is not stable, so exercise META-before-pointer as well.
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'od-main-local': [privateListMeta(), listPointer(DEV)] as never },
    });

    const res = await get(asUser(DEV));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.sourceLists).toEqual([
      {
        listId: LIST,
        title: 'Owner private packing',
        icon: 'check-square',
        itemCount: 7,
        doneCount: 2,
      },
    ]);
  });
});

/**
 * `listId` and `listItemId` are gated by `assertListAccess`, which arrives with lists in
 * Phase 3 (`api-contract.md` §2.3). Until it exists the condition for returning them cannot
 * be met, so they are not returned — and this test is what stops them being added back
 * without the check.
 */
describe('the list reverse-link is not returned yet', () => {
  it('omits listId and listItemId even when the stored row carries them', async () => {
    seed([
      meta({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XC',
        listItemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XD',
      }),
    ]);

    const raw = await (await get(createApp())).text();

    expect(raw).not.toContain('lst_');
    expect(raw).not.toContain('itm_');
  });
});

describe('a caller with no relationship', () => {
  /** `404`, never `403`, so a guessed id cannot confirm that an activity exists. */
  it('gets 404 rather than 403 for somebody else’s activity', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    const res = await get(asUser('usr_stranger'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Activity not found.');
  });

  it('gets the identical answer for an activity that does not exist', async () => {
    ddbMock.on(GetCommand).resolves({});

    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe('Activity not found.');
  });

  it('refuses after exact strong META and caller-index reads without collection reads', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    await get(asUser('usr_stranger'));

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
    expect(
      ddbMock
        .commandCalls(GetCommand)
        .every((call) => call.args[0].input.ConsistentRead === true),
    ).toBe(true);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  /** A malformed id resolves to nothing and answers 404, rather than a second status. */
  it('404s a malformed id rather than 400ing it', async () => {
    ddbMock.on(GetCommand).resolves({});

    const res = await get(createApp(), 'not-an-id');

    expect(res.status).toBe(404);
  });
});
