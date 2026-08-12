import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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

const DEV = 'usr_local_dev';
const OTHER = 'usr_someone_else';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

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

/**
 * Seeds both reads the request makes: `assertActivityAccess`'s `GetItem` on the canonical row,
 * and the partition `Query` the projection runs.
 */
const seed = (partition: Record<string, unknown>[]) => {
  ddbMock
    .on(GetCommand)
    .resolves({ Item: partition.find((row) => row.sk === 'META') as never });
  ddbMock.on(QueryCommand).resolves({ Items: partition as never });
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const get = (app: ReturnType<typeof CreateApp>, id = ACT) =>
  app.fetch(new Request(`http://localhost/v1/activities/${id}`));

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

    expect(Object.keys(body.data).sort()).toEqual([
      'activity',
      'completedOccurrenceCount',
      'reminders',
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
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('returns an empty reminders array when there are none', async () => {
    seed([meta()]);

    const body = await (await get(createApp())).json();

    expect(body.data.reminders).toEqual([]);
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

  /** One `GetItem` for the access check and one `Query` for the partition — two, budget three. */
  it('costs two round trips', async () => {
    seed([meta()]);

    await get(createApp());

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
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
    seed(shared());
    // The other user owns this one, so the access check admits them.
    ddbMock.on(GetCommand).resolves({ Item: meta({ ownerId: OTHER }) as never });

    const raw = await (await get(asUser(OTHER))).text();
    const body = JSON.parse(raw);

    expect(body.data.reminders).toHaveLength(1);
    expect(body.data.reminders[0].userId).toBe(OTHER);
    expect(raw).not.toContain(REMINDER_OF[DEV]);
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

  /**
   * The stranger path *does* query the activity partition once — `assertActivityAccess` reads
   * the participant rows before deciding, by their own sort-key prefix. What must never
   * happen is the **unfiltered** partition read the projection runs, because that is the one
   * that loads other users' reminders. Distinguished by the prefix condition rather than by
   * the count, which would pass for the wrong reason.
   */
  it('never runs the unfiltered partition read when the check refuses', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    await get(asUser('usr_stranger'));

    const unfiltered = ddbMock
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input)
      .filter(
        (input) =>
          String(input.ExpressionAttributeValues?.[':pk']).startsWith('ACT#') &&
          input.ExpressionAttributeValues?.[':skPrefix'] === undefined,
      );

    expect(unfiltered).toHaveLength(0);
  });

  /** A malformed id resolves to nothing and answers 404, rather than a second status. */
  it('404s a malformed id rather than 400ing it', async () => {
    ddbMock.on(GetCommand).resolves({});

    const res = await get(createApp(), 'not-an-id');

    expect(res.status).toBe(404);
  });
});
