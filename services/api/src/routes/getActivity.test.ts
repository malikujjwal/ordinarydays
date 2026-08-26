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
 * Seeds the strong partition snapshot used for authorisation and projection, and answers the
 * feed's own bounded `UPD#` read separately.
 *
 * Two Queries, discriminated by their key condition, because that is what the endpoint now
 * issues: §2.3 composes detail from bounded sort-key-prefix Queries, and P3-19's feed page is
 * one of them. A single blanket mock would hand partition rows to the feed reader and hide
 * that the two reads have different shapes.
 */
const seed = (
  partition: Record<string, unknown>[],
  updates: Record<string, unknown>[] = [],
  attachments: Record<string, unknown>[] = [],
) => {
  /**
   * Routed by sort-key prefix, because the endpoint issues four Queries and they are not
   * interchangeable: the partition, the feed's own page (P3-19), the caller's bounded
   * pending-upload drain and the attachment collection (P3-22). A fixture that answered all
   * four with the partition would hand `ATT#` rows to a parser expecting attachments — which
   * is what a real `begins_with` Query can never do, so the mock has to be as specific as
   * DynamoDB is.
   */
  ddbMock.on(QueryCommand).callsFake((input) => {
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    switch (values[':skPrefix']) {
      case 'UPD#':
        return { Items: updates as never };
      case 'ATT#':
        return { Items: attachments as never };
      case 'UPLOAD#':
        return { Items: [] as never };
      default:
        return { Items: partition as never };
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
     * client written against Phase 1 keeps working. `updates` is P3-19's addition and
     * `attachments` is P3-22's.
     */
    expect(Object.keys(body.data).sort()).toEqual([
      'activity',
      'attachments',
      'capabilities',
      'completedOccurrenceCount',
      'reminders',
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
     * **Four Queries, and no more**: the authoritative partition snapshot, the feed's bounded
     * newest-first page (P3-19), the caller's bounded pending-upload drain and the bounded
     * attachment collection (P3-22). It was one until the feed was embedded; §2.3 has always
     * specified bounded prefix Queries — plural — assembling the named sections, and the
     * property worth pinning is that **none is per-row and none is unbounded**. A count that
     * grew with the number of attachments, or a read per attachment, is what this catches.
     */
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(4);
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

  it('authorises and projects from one strongly consistent partition Query', async () => {
    seed([meta()]);

    await get(createApp());

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(4);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ConsistentRead).toBe(
      true,
    );
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
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(4);
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
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.message).toBe('Activity not found.');
  });

  it('refuses from the same single strong snapshot without a preliminary META read', async () => {
    seed([meta(), reminderOf(DEV, -15)]);

    await get(asUser('usr_stranger'));

    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    /**
     * **One**, not two. Authorisation fails before the feed is read, so a stranger never
     * causes a `UPD#` Query — they cannot learn that a plan has a feed, or that it exists, by
     * timing the refusal.
     */
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ConsistentRead).toBe(
      true,
    );
  });

  /** A malformed id resolves to nothing and answers 404, rather than a second status. */
  it('404s a malformed id rather than 400ing it', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await get(createApp(), 'not-an-id');

    expect(res.status).toBe(404);
  });
});
