import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
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

/** `DELETE /v1/activities/:id` and its cascade (P1-14). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CHILD = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const meta = (id: string, overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${id}`,
  sk: 'META',
  entity: 'Activity',
  activityId: id,
  ownerId: DEV,
  status: 'saved',
  objectKind: 'plan',
  type: 'custom',
  title: 'Paris weekend',
  details: { kind: 'custom' },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

const reminderRow = () => ({
  pk: `ACT#${PLAN}`,
  sk: `REM#${DEV}#rem_01J8XKQ2M4N5P6R7S8T9V0W1AA`,
  entity: 'Reminder',
  reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA',
  activityId: PLAN,
  userId: DEV,
  offsetMinutes: -15,
  channel: 'push',
});

const childPointerRow = () => ({
  pk: `ACT#${PLAN}`,
  sk: `SUB#${CHILD}`,
  entity: 'ChildPointer',
  childActivityId: CHILD,
  title: 'Book hotel',
  status: 'saved',
});

/**
 * Seeds the two reads a delete makes: the access check's `GetItem` on the canonical row, and
 * the partition `Query` the cascade reads its `SUB#` pointers from. `GetItem` is keyed so a
 * prep task's own row can be answered too.
 */
const seed = (
  partition: Record<string, unknown>[],
  rows: Record<string, Record<string, unknown> | undefined> = {},
) => {
  const byId: Record<string, Record<string, unknown> | undefined> = {
    [PLAN]: partition.find((row) => row.sk === 'META'),
    ...rows,
  };

  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: byId[String(input.Key.pk).replace('ACT#', '')],
  }));
  ddbMock.on(QueryCommand).resolves({ Items: partition as never });
  ddbMock.on(BatchWriteCommand).resolves({});
  ddbMock.on(TransactWriteCommand).resolves({});
};

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const del = (app: ReturnType<typeof CreateApp>, id = PLAN) =>
  app.fetch(new Request(`http://localhost/v1/activities/${id}`, { method: 'DELETE' }));

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

/**
 * Every key the delete removed, across **both** mechanisms.
 *
 * P2-49 moved META's delete out of a second batch and into a transaction with the tombstone's
 * put, so a batch-only view would report META as never deleted. What these tests assert — that
 * the cascade removes the whole partition — is unchanged; where the last write goes is not
 * their subject.
 */
const deletedKeys = () => [
  ...ddbMock
    .commandCalls(BatchWriteCommand)
    .flatMap((call) => Object.values(call.args[0].input.RequestItems ?? {}).flat())
    .map(
      (request) =>
        (request as { DeleteRequest?: { Key?: Record<string, unknown> } }).DeleteRequest
          ?.Key,
    )
    .filter((key): key is Record<string, unknown> => key !== undefined),
  ...ddbMock
    .commandCalls(TransactWriteCommand)
    .flatMap((call) => call.args[0].input.TransactItems ?? [])
    .map((entry) => (entry as { Delete?: { Key?: Record<string, unknown> } }).Delete?.Key)
    .filter((key): key is Record<string, unknown> => key !== undefined),
];

/**
 * Transactions that actually touch the child.
 *
 * These tests used to count **every** `TransactWriteCommand`, which worked only while the
 * delete itself used none. P2-49 gives the delete one of its own — META's removal and the
 * tombstone's put, atomically — so a bare count now conflates "a prep task was released"
 * with "an activity was deleted". Naming the child is what the assertions always meant.
 */
const childReleaseTransactions = () =>
  ddbMock.commandCalls(TransactWriteCommand).filter((call) =>
    (call.args[0].input.TransactItems ?? []).some((entry) => {
      const item = entry as {
        Put?: { Item?: Record<string, unknown> };
        Update?: { Key?: Record<string, unknown> };
        Delete?: { Key?: Record<string, unknown> };
      };
      const touched = item.Put?.Item ?? item.Update?.Key ?? item.Delete?.Key ?? undefined;
      return (
        touched !== undefined &&
        (String(touched.pk) === `ACT#${CHILD}` || touched.activityId === CHILD)
      );
    }),
  );

describe('deleting an activity', () => {
  it('returns 200 naming the id that is gone', async () => {
    seed([meta(PLAN)]);

    const res = await del(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.activityId).toBe(PLAN);
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('removes every item in the partition', async () => {
    seed([meta(PLAN), reminderRow()]);

    await del(createApp());

    const sks = deletedKeys()
      .filter((key) => String(key.pk).startsWith('ACT#'))
      .map((key) => key.sk);

    expect(sks).toContain('META');
    expect(sks).toContain(`REM#${DEV}#rem_01J8XKQ2M4N5P6R7S8T9V0W1AA`);
  });

  it('removes the owner’s index entry too', async () => {
    seed([meta(PLAN)]);

    await del(createApp());

    expect(deletedKeys()).toContainEqual({ pk: `USER#${DEV}`, sk: `IDX#${PLAN}` });
  });

  it('returns a body the shared schema accepts', async () => {
    const { deletedActivity } = await import('@od/shared/schemas');
    seed([meta(PLAN)]);

    const body = await (await del(createApp())).json();

    expect(deletedActivity.safeParse(body.data).success).toBe(true);
  });
});

/**
 * **Prep tasks survive their parent.** A user who cancels a trip may still need to return
 * the rental car; cascade-deleting their real to-dos because the container went away is the
 * data loss that ends trust in a planner (`today-and-tasks.md` §5.5).
 */
describe('the prep tasks', () => {
  const withChild = () => [meta(PLAN), childPointerRow()];
  const child = () =>
    meta(CHILD, {
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      details: { kind: 'task' },
      parentActivityId: PLAN,
    });

  it('are not deleted', async () => {
    seed(withChild(), { [CHILD]: child() });

    await del(createApp());

    expect(deletedKeys().map((key) => key.pk)).not.toContain(`ACT#${CHILD}`);
  });

  it('have their parentActivityId cleared', async () => {
    seed(withChild(), { [CHILD]: child() });

    await del(createApp());

    const items = ddbMock
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? []) as Array<{
      Put?: { Item?: Record<string, unknown> };
    }>;
    const written = items.find(
      (entry) =>
        entry.Put?.Item?.entity === 'Activity' && entry.Put.Item.activityId === CHILD,
    )?.Put?.Item;

    expect(written).toBeDefined();
    expect(written).not.toHaveProperty('parentActivityId');
  });

  /**
   * The child's index entry carries the parent's title as its subtitle. Rewriting the whole
   * entry is what drops it — the title is about to stop existing.
   */
  it('lose the parent title from their index subtitle', async () => {
    seed(withChild(), { [CHILD]: child() });

    await del(createApp());

    const items = ddbMock
      .commandCalls(TransactWriteCommand)
      .flatMap((call) => call.args[0].input.TransactItems ?? []) as Array<{
      Put?: { Item?: Record<string, unknown> };
    }>;
    const entry = items.find(
      (e) => e.Put?.Item?.entity === 'ActivityIndex' && e.Put.Item.activityId === CHILD,
    )?.Put?.Item;

    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('subtitle');
  });

  /** Cleared **before** the parent goes, so a failure never strands a task on a ghost. */
  it('are cleared before the parent is removed', async () => {
    seed(withChild(), { [CHILD]: child() });

    await del(createApp());

    expect(childReleaseTransactions()).toHaveLength(1);
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThan(0);
  });

  /** A pointer to a child that has already gone is stale, not a failure — this is a retry path. */
  it('skip a pointer whose child no longer exists', async () => {
    seed(withChild(), { [CHILD]: undefined });

    const res = await del(createApp());

    expect(res.status).toBe(200);
    expect(childReleaseTransactions()).toHaveLength(0);
  });

  /** A child re-parented since the pointer was written is left alone. */
  it('skip a child that no longer names this parent', async () => {
    seed(withChild(), { [CHILD]: meta(CHILD, { parentActivityId: undefined }) });

    await del(createApp());

    expect(childReleaseTransactions()).toHaveLength(0);
  });
});

describe('who may delete', () => {
  /** Owner only. A participant can see the plan, so they are told — `403`, not `404`. */
  it('403s a participant', async () => {
    seed([meta(PLAN)]);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { entity: 'Participant', personId: 'psn_x', userId: 'usr_participant' },
      ] as never,
    });

    const res = await del(asUser('usr_participant'));

    expect(res.status).toBe(403);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('404s a stranger, and deletes nothing', async () => {
    seed([meta(PLAN)]);

    const res = await del(asUser('usr_stranger'));

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});

/**
 * The removal batches rather than transacting, so a partial failure is finished by a retry.
 * The second call finds nothing and answers `404` — the honest report, not a crash.
 */
describe('calling it twice', () => {
  it('404s the second time without throwing', async () => {
    seed([meta(PLAN)]);
    expect((await del(createApp())).status).toBe(200);

    ddbMock.on(GetCommand).resolves({});
    const second = await del(createApp());

    expect(second.status).toBe(404);
    expect((await second.json()).error.code).toBe('not_found');
  });

  it('404s an activity that never existed', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect((await del(createApp())).status).toBe(404);
  });
});
