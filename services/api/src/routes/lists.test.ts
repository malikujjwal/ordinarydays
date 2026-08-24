import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
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

/** `/v1/lists` — create, page, detail and delete (P3-05). */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const LST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const ITM2 = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X5';
const TABLE = 'od-main-local';

const listMetaRow = (overrides: Record<string, unknown> = {}) => ({
  pk: `LIST#${LST}`,
  sk: 'META',
  entity: 'List',
  listId: LST,
  ownerId: DEV,
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 2,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-23T00:00:00.000Z',
  ...overrides,
});

const pointerRow = (userId = DEV, role = 'owner') => ({
  pk: `USER#${userId}`,
  sk: `LIST#${LST}`,
  entity: 'ListIndex',
  listId: LST,
  userId,
  role,
  addedAt: '2026-08-23T00:00:00.000Z',
});

const itemRow = (itemId: string, rank: string) => ({
  pk: `LIST#${LST}`,
  sk: `ITEM#${rank}#${itemId}`,
  entity: 'ListItem',
  itemId,
  listId: LST,
  rank,
  itemRevision: 0,
  title: 'Chicken',
  checked: false,
});

const linkRow = (itemId: string) => ({
  pk: `LIST#${LST}`,
  sk: `LNK#${DEV}#${itemId}`,
  entity: 'ListItemActivityLink',
  listId: LST,
  itemId,
  viewerUserId: DEV,
  activityId: ACT,
  linkedAt: '2026-08-23T00:00:00.000Z',
});

const activityMetaRow = (ownerId = DEV, overrides: Record<string, unknown> = {}) => ({
  pk: `ACT#${ACT}`,
  sk: 'META',
  entity: 'Activity',
  activityId: ACT,
  ownerId,
  objectKind: 'plan',
  type: 'custom',
  status: 'saved',
  title: 'New York Trip',
  details: { kind: 'custom' },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  lastActivityAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

/** Answers exact-key `GetItem`s from a map, and `undefined` for anything unseeded. */
const seedGets = (rows: Record<string, unknown>[]) => {
  const byKey = new Map(rows.map((row) => [`${row.pk}|${row.sk}`, row]));
  ddbMock
    .on(GetCommand)
    .callsFake((input) => ({ Item: byKey.get(`${input.Key.pk}|${input.Key.sk}`) }));
};

beforeEach(async () => {
  ddbMock.reset();
  ddbMock.on(TransactWriteCommand).resolves({});
  // countOwnedLists issues a Select COUNT query; everything else queried here pages items.
  ddbMock
    .on(QueryCommand)
    .callsFake((input) => (input.Select === 'COUNT' ? { Count: 0 } : { Items: [] }));
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

const asUser = (userId: string) =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

const post = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': crypto.randomUUID() },
) =>
  app.fetch(
    new Request('http://localhost/v1/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const get = (app: ReturnType<typeof CreateApp>, path: string) =>
  app.fetch(new Request(`http://localhost${path}`));

const del = (app: ReturnType<typeof CreateApp>, id = LST) =>
  app.fetch(new Request(`http://localhost/v1/lists/${id}`, { method: 'DELETE' }));

const transacted = () =>
  ddbMock
    .commandCalls(TransactWriteCommand)
    .flatMap((call) => call.args[0].input.TransactItems ?? []) as Array<{
    Put?: { Item?: Record<string, unknown> };
    Delete?: { Key?: Record<string, unknown> };
    Update?: { Key?: Record<string, unknown>; UpdateExpression?: string };
    ConditionCheck?: { Key?: Record<string, unknown> };
  }>;

const listMetaWrite = () =>
  transacted().find((entry) => entry.Put?.Item?.entity === 'List')?.Put?.Item;

describe('creating a list', () => {
  it('copies the selected template onto the row — 201 with every seeded field', async () => {
    const res = await post(createApp(), {
      title: 'Trader Joe’s',
      templateKey: 'groceries',
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.listId).toMatch(/^lst_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data).toMatchObject({
      ownerId: DEV,
      behaviour: 'collection',
      templateKey: 'groceries',
      title: 'Trader Joe’s',
      icon: 'cart',
      emptyStateCopy: 'Add something to buy.',
      capabilities: { checkable: true, supportsLocation: false },
      slot: 'groceries',
      itemCount: 0,
      uncheckedCount: 0,
      memberCount: 1,
      rankVersion: 0,
      archived: false,
    });
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('returns a body the shared ListView schema accepts, with no storage attributes', async () => {
    const { listView } = await import('@od/shared/schemas');
    const body = await (
      await post(createApp(), { title: 'Groceries', templateKey: 'groceries' })
    ).json();

    expect(listView.safeParse(body.data).success).toBe(true);
    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  it('writes META, the tombstone check and the owner pointer in one transaction', async () => {
    await post(createApp(), { title: 'Groceries', templateKey: 'groceries' });

    const items = transacted();
    expect(items.some((entry) => entry.Put?.Item?.entity === 'List')).toBe(true);
    expect(
      items.some(
        (entry) =>
          entry.ConditionCheck?.Key?.pk?.toString().startsWith('LIST#') &&
          entry.ConditionCheck?.Key?.sk === 'TOMBSTONE',
      ),
    ).toBe(true);
    expect(
      items.some(
        (entry) =>
          entry.Put?.Item?.entity === 'ListIndex' && entry.Put?.Item?.role === 'owner',
      ),
    ).toBe(true);
    expect(items.some((entry) => entry.Put?.Item?.entity === 'Idempotency')).toBe(true);
  });

  it('requires an Idempotency-Key — the registry entry mutates', async () => {
    const res = await post(createApp(), { title: 'x', templateKey: 'groceries' }, {});

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('Idempotency-Key');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([
    ['behaviour', 'collection'],
    ['capabilities', { checkable: true, supportsLocation: false }],
    ['slot', 'groceries'],
    ['icon', 'cart'],
    ['emptyStateCopy', 'Add something.'],
  ])('400s a client-supplied seeded field %s, writing nothing', async (field, value) => {
    const res = await post(createApp(), {
      title: 'Groceries',
      templateKey: 'groceries',
      [field]: value,
    });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s an unknown templateKey naming it, and never substitutes a style', async () => {
    const res = await post(createApp(), { title: 'Costco run', templateKey: 'grocery' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.[0]?.path).toBe('templateKey');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s a missing templateKey and an empty title, writing nothing', async () => {
    expect((await post(createApp(), { title: 'Costco run' })).status).toBe(400);
    expect(
      (await post(createApp(), { title: '', templateKey: 'groceries' })).status,
    ).toBe(400);
    expect((await post(createApp(), { templateKey: 'groceries' })).status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('400s a malformed client-minted listId', async () => {
    const res = await post(createApp(), {
      listId: 'lst_not-a-ulid',
      title: 'Groceries',
      templateKey: 'groceries',
    });

    expect(res.status).toBe(400);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('stores a supplied client-minted listId as identity only', async () => {
    const body = await (
      await post(createApp(), {
        listId: LST,
        title: 'Groceries',
        templateKey: 'groceries',
      })
    ).json();

    expect(body.data.listId).toBe(LST);
    expect(listMetaWrite()?.listId).toBe(LST);
    expect(listMetaWrite()?.ownerId).toBe(DEV);
  });

  it('answers a colliding id with the metadata-free conflict Activity creation uses', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        $metadata: {},
        message: 'cancelled',
        CancellationReasons: [
          { Code: 'ConditionalCheckFailed' },
          { Code: 'None' },
          { Code: 'None' },
          { Code: 'None' },
        ],
      }),
    );

    const res = await post(createApp(), {
      listId: LST,
      title: 'Groceries',
      templateKey: 'groceries',
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toBe('That id is already in use. Try again.');
    expect(body.error.details).toBeUndefined();
  });

  it('400s the 101st owned list', async () => {
    ddbMock
      .on(QueryCommand)
      .callsFake((input) => (input.Select === 'COUNT' ? { Count: 100 } : { Items: [] }));

    const res = await post(createApp(), { title: 'One more', templateKey: 'groceries' });

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  describe('from a source Plan', () => {
    it('forces the copied slot to null and writes the id-only projection', async () => {
      seedGets([activityMetaRow()]);

      const res = await post(createApp(), {
        title: 'Groceries · New York Trip',
        templateKey: 'groceries',
        sourceActivityId: ACT,
      });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.data.slot).toBeNull();
      expect(body.data.sourceActivityId).toBe(ACT);
      const projection = transacted().find(
        (entry) => entry.Put?.Item?.entity === 'SourceList',
      )?.Put?.Item;
      expect(projection?.pk).toBe(`ACT#${ACT}`);
      expect(projection?.sk).toMatch(/^SOURCE_LIST#lst_/);
      // Id-only: no title and no counts, so a rename stays one write.
      expect(projection).not.toHaveProperty('title');
      expect(projection).not.toHaveProperty('itemCount');
    });

    it('re-asserts the source Plan inside the create transaction', async () => {
      seedGets([activityMetaRow()]);

      await post(createApp(), {
        title: 'Groceries',
        templateKey: 'groceries',
        sourceActivityId: ACT,
      });

      // The service's pre-read can go stale; the commit-time checks are what stop a
      // deleted or converted Plan from gaining a fresh projection.
      const checks = transacted().flatMap((entry) =>
        entry.ConditionCheck === undefined ? [] : [entry.ConditionCheck],
      ) as Array<{
        Key?: Record<string, unknown>;
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      }>;
      const metaCheck = checks.find(
        (check) => check.Key?.pk === `ACT#${ACT}` && check.Key?.sk === 'META',
      );
      expect(metaCheck?.ConditionExpression).toContain('attribute_exists(pk)');
      expect(metaCheck?.ExpressionAttributeValues).toMatchObject({
        ':sourceOwner': DEV,
        ':plan': 'plan',
      });
      expect(
        checks.some(
          (check) => check.Key?.pk === `ACT#${ACT}` && check.Key?.sk === 'TOMBSTONE',
        ),
      ).toBe(true);
    });

    it('400s a source that is not a Plan, writing nothing', async () => {
      seedGets([activityMetaRow(DEV, { objectKind: 'task', type: 'task' })]);

      const res = await post(createApp(), {
        title: 'Groceries',
        templateKey: 'groceries',
        sourceActivityId: ACT,
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error.details?.[0]?.path).toBe('sourceActivityId');
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    it('404s a stranger’s Plan, writing nothing', async () => {
      seedGets([activityMetaRow('usr_somebody_else')]);

      const res = await post(createApp(), {
        title: 'Groceries',
        templateKey: 'groceries',
        sourceActivityId: ACT,
      });

      expect(res.status).toBe(404);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });
});

describe('GET /v1/lists', () => {
  it('pages pointers and batch-reads META, projecting storage attributes away', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [pointerRow()] as never });
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [listMetaRow()] as never } });

    const res = await get(createApp(), '/v1/lists');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].listId).toBe(LST);
    expect(body.data[0]).not.toHaveProperty('pk');
    expect(body.data[0]).not.toHaveProperty('rankRepairId');
    expect(body.meta.nextCursor).toBeUndefined();
  });

  it('sets meta.nextCursor only when the pointer page has more', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [pointerRow()] as never,
      LastEvaluatedKey: { pk: `USER#${DEV}`, sk: `LIST#${LST}` },
    });
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [listMetaRow()] as never } });

    const body = await (await get(createApp(), '/v1/lists')).json();

    expect(typeof body.meta.nextCursor).toBe('string');
  });

  it('400s a malformed cursor', async () => {
    const res = await get(createApp(), '/v1/lists?cursor=%23%23%23');

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/lists/:id', () => {
  it('returns META only without the flag', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const res = await get(createApp(), `/v1/lists/${LST}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.list.listId).toBe(LST);
    expect(body.data.items).toBeUndefined();
    expect(body.data.list).not.toHaveProperty('pk');
  });

  it('never serialises the repair or migration markers', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    const body = await (await get(createApp(), `/v1/lists/${LST}`)).json();

    expect(body.data.list).not.toHaveProperty('rankRepairId');
    expect(body.data.list).not.toHaveProperty('behaviourMigrationId');
  });

  it('joins only the caller’s readable viewerLink onto the fenced first page', async () => {
    seedGets([pointerRow(), listMetaRow(), activityMetaRow()]);
    ddbMock
      .on(QueryCommand)
      .resolves({ Items: [itemRow(ITM, 'a0'), itemRow(ITM2, 'a1')] as never });
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [linkRow(ITM)] as never } });

    const body = await (
      await get(createApp(), `/v1/lists/${LST}?includeItems=true`)
    ).json();

    expect(body.data.items).toHaveLength(2);
    const linked = body.data.items.find(
      (entry: { item: { itemId: string } }) => entry.item.itemId === ITM,
    );
    const unlinked = body.data.items.find(
      (entry: { item: { itemId: string } }) => entry.item.itemId === ITM2,
    );
    expect(linked.viewerLink.activityId).toBe(ACT);
    expect(unlinked.viewerLink).toBeUndefined();
    expect(linked.item).not.toHaveProperty('itemRevision');
    expect(linked.item).not.toHaveProperty('pk');
  });

  it('omits a stale pointer whose Activity is gone', async () => {
    // The activity META is deliberately unseeded, so authorisation answers not_found.
    seedGets([pointerRow(), listMetaRow()]);
    ddbMock
      .on(QueryCommand)
      .callsFake((input) =>
        String(input.ExpressionAttributeValues?.[':pk'] ?? '').startsWith('LIST#')
          ? { Items: [itemRow(ITM, 'a0')] }
          : { Items: [] },
      );
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [linkRow(ITM)] as never } });

    const body = await (
      await get(createApp(), `/v1/lists/${LST}?includeItems=true`)
    ).json();

    expect(body.data.items[0].viewerLink).toBeUndefined();
  });

  /**
   * The read **drains** the standing work before it gives up (P3-09), so the fixture carries
   * the work record a marker always has — the two are written and cleared in one transaction,
   * and a marker naming nothing is a different failure with its own answer. The drain runs
   * here and the page is still refused, which is the point: a fence that survives the drain —
   * because the marker is still standing, or because `rankVersion` moved under the read — is
   * the retryable answer, never a page spanning two generations.
   */
  it('503s with Retry-After 1 when a work marker fences the item page', async () => {
    seedGets([
      pointerRow(),
      listMetaRow({ rankRepairId: 'op_1' }),
      {
        pk: `LIST#${LST}`,
        sk: 'RANK_REPAIR#op_1',
        entity: 'ListRankRepair',
        listId: LST,
        operationId: 'op_1',
        state: 'rewriting',
        entries: [],
        cursor: 0,
        rankVersion: 0,
      },
    ]);

    const res = await get(createApp(), `/v1/lists/${LST}?includeItems=true`);

    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('1');
    expect((await res.json()).error.code).toBe('internal');
  });

  it('404s a stranger — indistinguishable from a list that does not exist', async () => {
    seedGets([listMetaRow()]);

    const res = await get(asUser('usr_stranger'), `/v1/lists/${LST}`);

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  it('400s an unknown query parameter — the schema is strict', async () => {
    seedGets([pointerRow(), listMetaRow()]);

    expect((await get(createApp(), `/v1/lists/${LST}?includeitems=true`)).status).toBe(
      400,
    );
  });
});

describe('DELETE /v1/lists/:id', () => {
  const seedDelete = (rows: Record<string, unknown>[] = []) => {
    seedGets([pointerRow(), listMetaRow(), ...rows]);
    ddbMock.on(QueryCommand).resolves({
      Items: [
        listMetaRow(),
        ...rows.filter((r) => String(r.pk).startsWith('LIST#')),
      ] as never,
    });
    ddbMock.on(BatchWriteCommand).resolves({});
  };

  it('200s naming the id that is gone, removing META and the owner pointer', async () => {
    seedDelete();

    const res = await del(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.listId).toBe(LST);
    const deletes = transacted().flatMap((entry) =>
      entry.Delete?.Key === undefined ? [] : [entry.Delete.Key],
    );
    expect(deletes).toContainEqual({ pk: `LIST#${LST}`, sk: 'META' });
    expect(deletes).toContainEqual({ pk: `USER#${DEV}`, sk: `LIST#${LST}` });
  });

  it('writes the replay-window tombstone before the cascade', async () => {
    seedDelete();

    await del(createApp());

    const tombstone = transacted().find(
      (entry) => entry.Put?.Item?.entity === 'ListTombstone',
    )?.Put?.Item;
    expect(tombstone).toMatchObject({ pk: `LIST#${LST}`, sk: 'TOMBSTONE', ownerId: DEV });
    expect(typeof tombstone?.ttl).toBe('number');
  });

  it('clears Activity provenance from LNK rows without deleting an Activity', async () => {
    seedDelete([linkRow(ITM), activityMetaRow(DEV, { listId: LST, listItemId: ITM })]);

    await del(createApp());

    const clears = ddbMock
      .commandCalls(UpdateCommand)
      .filter((call) => String(call.args[0].input.Key?.pk).startsWith('ACT#'));
    expect(clears).toHaveLength(1);
    expect(clears[0]?.args[0].input.UpdateExpression).toBe('REMOVE #listId, #listItemId');
    // The concurrency token is left alone: provenance cleanup is not a user edit.
    expect(clears[0]?.args[0].input.UpdateExpression).not.toContain('updatedAt');
    // No transaction or batch item deletes the Activity itself.
    expect(
      transacted().some((entry) => String(entry.Delete?.Key?.pk).startsWith('ACT#')),
    ).toBe(false);
  });

  it('removes the source projection when the list came from a Plan', async () => {
    seedGets([pointerRow(), listMetaRow({ sourceActivityId: ACT, slot: null })]);
    ddbMock.on(QueryCommand).resolves({
      Items: [listMetaRow({ sourceActivityId: ACT, slot: null })] as never,
    });
    ddbMock.on(BatchWriteCommand).resolves({});

    await del(createApp());

    expect(
      transacted().some(
        (entry) =>
          entry.Delete?.Key?.pk === `ACT#${ACT}` &&
          entry.Delete?.Key?.sk === `SOURCE_LIST#${LST}`,
      ),
    ).toBe(true);
  });

  it('always attempts the conditional profile-default clear in the META transaction', async () => {
    // No profile pre-read decides this: a stale read that missed a concurrent selection
    // would wrongly skip the cleanup. The condition is what protects any other value.
    seedDelete();

    await del(createApp());

    const profileClear = transacted().find((entry) => entry.Update?.Key?.sk === 'PROFILE')
      ?.Update as
      | {
          UpdateExpression?: string;
          ConditionExpression?: string;
          ExpressionAttributeValues?: Record<string, unknown>;
        }
      | undefined;
    expect(profileClear?.UpdateExpression).toBe('REMOVE #defaultLists.#slot');
    expect(profileClear?.ConditionExpression).toContain('#defaultLists.#slot = :listId');
    expect(profileClear?.ExpressionAttributeValues).toMatchObject({ ':listId': LST });
    // It rides the same transaction as META's delete.
    const finish = ddbMock
      .commandCalls(TransactWriteCommand)
      .find((call) =>
        (call.args[0].input.TransactItems ?? []).some(
          (item) =>
            (item as { Delete?: { Key?: { sk?: string } } }).Delete?.Key?.sk === 'META',
        ),
      );
    expect(
      (finish?.args[0].input.TransactItems ?? []).some(
        (item) =>
          (item as { Update?: { Key?: { sk?: string } } }).Update?.Key?.sk === 'PROFILE',
      ),
    ).toBe(true);
  });

  it('attempts no profile item when the list holds no slot', async () => {
    seedGets([pointerRow(), listMetaRow({ slot: null })]);
    ddbMock.on(QueryCommand).resolves({ Items: [listMetaRow({ slot: null })] as never });
    ddbMock.on(BatchWriteCommand).resolves({});

    await del(createApp());

    expect(transacted().some((entry) => entry.Update?.Key?.sk === 'PROFILE')).toBe(false);
  });

  it('deletes a member’s roster row and their pointer in one atomic transaction', async () => {
    const memberRow = {
      pk: `LIST#${LST}`,
      sk: 'MEMBER#psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
      entity: 'ListMember',
      listId: LST,
      personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X7',
      userId: 'usr_int_ben',
      reciprocalPersonId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X8',
      displayName: 'Ben',
      role: 'member',
      status: 'active',
      invitedBy: DEV,
      addedAt: '2026-08-23T00:00:00.000Z',
    };
    seedDelete([memberRow]);

    await del(createApp());

    // The roster row is the only durable record of where the pointer lives, so the two
    // must go together — a batch delete of the row alone could strand the pointer.
    const pairTransaction = ddbMock
      .commandCalls(TransactWriteCommand)
      .find((call) =>
        (call.args[0].input.TransactItems ?? []).some(
          (item) =>
            (item as { Delete?: { Key?: { sk?: string } } }).Delete?.Key?.sk ===
            memberRow.sk,
        ),
      );
    expect(pairTransaction).toBeDefined();
    expect(
      (pairTransaction?.args[0].input.TransactItems ?? []).some((item) => {
        const key = (item as { Delete?: { Key?: { pk?: string; sk?: string } } }).Delete
          ?.Key;
        return key?.pk === 'USER#usr_int_ben' && key?.sk === `LIST#${LST}`;
      }),
    ).toBe(true);
    // And the batch path never sees the roster row again.
    const batched = ddbMock
      .commandCalls(BatchWriteCommand)
      .flatMap((call) => Object.values(call.args[0].input.RequestItems ?? {}).flat())
      .map(
        (request) =>
          (request as { DeleteRequest?: { Key?: { sk?: string } } }).DeleteRequest?.Key
            ?.sk,
      );
    expect(batched).not.toContain(memberRow.sk);
  });

  it('403s a member — owner only', async () => {
    seedGets([pointerRow(DEV, 'member'), listMetaRow()]);

    const res = await del(createApp());

    expect(res.status).toBe(403);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('404s a stranger and a second call alike, deleting nothing', async () => {
    seedGets([listMetaRow()]);

    const res = await del(createApp());

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});
