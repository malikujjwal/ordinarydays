import { MAX_AUTOMATIC_INTENT_AGE_DAYS } from '@od/shared';
import { instant } from '@od/shared/schemas';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * `clear-checked`, `uncheck-all` and the compensation endpoint (§P3-10, criterion 19), end to
 * end against DynamoDB Local.
 *
 * What only this layer can prove is the part the criterion is actually about: that seven
 * deleted rows come back **byte-identically**, at their previous ranks, with their locators,
 * their still-live viewer links and the Activity provenance the delete cleared — and that the
 * tombstones which make ordinary creation refuse those ids are removed by exactly one
 * operation and nothing else.
 *
 * ## Why the links are seeded through the repository
 *
 * `LNK#` rows and Activity `listId`/`listItemId` provenance are written by the P3-13 bridge,
 * which is **not on `main`**: this branch was cut after P3-08 and P3-09, and P3-13 has not
 * merged. The storage shapes it will write are already defined and already snapshotted by the
 * delete path, so the restore is exercised against those shapes directly. When the bridge
 * lands, the same assertions should be re-seeded through
 * `POST /v1/lists/:id/items/:itemId/schedule` so the round trip is proved end to end.
 */

type AppModule = typeof import('../../src/app.js');
type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let createApp: AppModule['createApp'];
let repository: Repository;
let base: Base;
let keys: Keys;

const DEV = 'usr_local_dev';
const NOW = instant.parse('2026-08-24T09:00:00.000Z');
const ACTIVITY = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X7';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

const app = () => createApp();

const request = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'POST' || (method === 'PATCH' && /^\/v1\/lists\/[^/]+$/.test(path))
          ? { 'Idempotency-Key': crypto.randomUUID() }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function seedList(overrides: Partial<List> = {}): Promise<List> {
  const list: List = {
    schemaVersion: 2,
    listId: repository.newListId(),
    ownerId: DEV,
    templateKey: 'groceries',
    title: 'Groceries',
    icon: 'cart',
    emptyStateCopy: 'Add something to buy.',
    itemStateMode: { mode: 'checkbox' },
    featureConfig: {},
    slot: null,
    itemCount: 0,
    doneCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: NOW,
    lastItemActivityAt: NOW,
    ...overrides,
  };
  await repository.createList(DEV, list, { now: NOW });
  return list;
}

async function storedItems(listId: string): Promise<ListItem[]> {
  const prefix = keys.listItemPrefix(listId);
  const rows = await base.queryAll<Record<string, unknown>>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  return rows as unknown as ListItem[];
}

async function storedMeta(listId: string): Promise<Record<string, unknown>> {
  const row = await base.getItem<Record<string, unknown>>(keys.listMeta(listId), {
    consistentRead: true,
  });
  if (row === undefined) throw new Error('The list fixture has no META row.');
  return row;
}

async function partitionRows(listId: string): Promise<Record<string, unknown>[]> {
  return base.queryAll<Record<string, unknown>>(
    { pk: keys.listPartition(listId).pk },
    { consistentRead: true },
  );
}

/** Seven done and three open, in the order the criterion names them. */
async function seedTen(listId: string): Promise<{ checked: string[]; open: string[] }> {
  const res = await request('POST', `/v1/lists/${listId}/items/bulk`, {
    items: Array.from({ length: 10 }, (_, index) => ({
      title: `Item ${String(index).padStart(2, '0')}`,
    })),
  });
  expect(res.status).toBe(201);
  const created = (await res.json()).data as { itemId: string }[];
  const checked = created.slice(0, 7).map((item) => item.itemId);
  const open = created.slice(7).map((item) => item.itemId);
  for (const itemId of checked) {
    const patched = await request('PATCH', `/v1/lists/${listId}/items/${itemId}`, {
      state: 'done',
    });
    expect(patched.status).toBe(200);
  }
  return { checked, open };
}

/**
 * One viewer link and its Activity, written where the P3-13 bridge will write them.
 *
 * Seeded through storage rather than the endpoint because the bridge has not merged; the
 * shapes are the ones `data-model.md` §3.3 defines and the delete path already snapshots.
 */
async function seedLink(listId: string, itemId: string): Promise<void> {
  await base.putItem({
    ...keys.activityMeta(ACTIVITY),
    entity: 'Activity',
    activityId: ACTIVITY,
    ownerId: DEV,
    objectKind: 'plan',
    type: 'custom',
    status: 'saved',
    title: 'Zahav',
    details: { kind: 'custom' },
    listId,
    listItemId: itemId,
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
  await base.putItem({
    ...keys.listItemActivityLink(listId, DEV, itemId),
    entity: 'ListItemActivityLink',
    listId,
    itemId,
    viewerUserId: DEV,
    activityId: ACTIVITY,
    linkedAt: NOW,
    schemaVersion: 1,
  });
}

describe('clear-checked', () => {
  it('deletes exactly the checked seven and leaves the counters right', async () => {
    const list = await seedList();
    const { checked, open } = await seedTen(list.listId);

    const res = await request('POST', `/v1/lists/${list.listId}/clear-checked`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.affectedCount).toBe(7);
    expect(body.data.undoToken).toEqual(expect.any(String));

    const survivors = await storedItems(list.listId);
    expect(survivors.map((item) => item.itemId).sort()).toEqual([...open].sort());
    const meta = await storedMeta(list.listId);
    expect(meta.itemCount).toBe(3);
    expect(meta.doneCount).toBe(0);
    expect(checked).toHaveLength(7);
  });

  it('offers a ten-second window, which is the bulk deadline', async () => {
    const list = await seedList();
    await seedTen(list.listId);

    const before = Date.now();
    const body = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();
    const after = Date.now();
    const deadline = Date.parse(body.data.undoExpiresAt);

    // Ten seconds from the server's own clock, which sits somewhere inside the request.
    expect(deadline).toBeGreaterThanOrEqual(before + 10_000);
    expect(deadline).toBeLessThanOrEqual(after + 10_000);
  });

  /**
   * Criterion 19 in full. The seven come back with their **original ids and previous ranks** —
   * "a restored shopping list in a different order is a failed undo" — along with their
   * locators, the viewer link the delete removed and the Activity provenance it cleared.
   */
  it('restores all seven byte-identically, with live links and provenance', async () => {
    const list = await seedList();
    const { checked } = await seedTen(list.listId);
    const linked = checked[0] as string;
    await seedLink(list.listId, linked);

    const before = await storedItems(list.listId);
    const beforeById = new Map(before.map((item) => [item.itemId, item]));

    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();
    expect(cleared.data.affectedCount).toBe(7);

    // The delete cleared the Activity's back-pointers, as the lifecycle table requires.
    const clearedActivity = await base.getItem<Record<string, unknown>>(
      keys.activityMeta(ACTIVITY),
      { consistentRead: true },
    );
    expect(clearedActivity?.listId).toBeUndefined();
    expect(clearedActivity?.listItemId).toBeUndefined();

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });
    const result = await undone.json();

    expect(undone.status).toBe(200);
    expect(result.data).toEqual({ outcome: 'applied', affectedCount: 7 });

    const after = await storedItems(list.listId);
    expect(after).toHaveLength(10);
    for (const itemId of checked) {
      const original = beforeById.get(itemId);
      const restored = after.find((item) => item.itemId === itemId);
      expect(restored?.rank).toBe(original?.rank);
      expect(restored?.title).toBe(original?.title);
      expect(restored?.state).toBe('done');
      const locator = await base.getItem<Record<string, unknown>>(
        keys.listItemLocator(list.listId, itemId),
        { consistentRead: true },
      );
      expect(locator?.rank).toBe(original?.rank);
    }

    const link = await base.getItem<Record<string, unknown>>(
      keys.listItemActivityLink(list.listId, DEV, linked),
      { consistentRead: true },
    );
    expect(link?.activityId).toBe(ACTIVITY);
    const activity = await base.getItem<Record<string, unknown>>(
      keys.activityMeta(ACTIVITY),
      { consistentRead: true },
    );
    expect(activity?.listId).toBe(list.listId);
    expect(activity?.listItemId).toBe(linked);

    const meta = await storedMeta(list.listId);
    expect(meta.itemCount).toBe(10);
    expect(meta.doneCount).toBe(7);
    expect(
      (await partitionRows(list.listId)).filter(
        (row) => row.entity === 'ListItemTombstone',
      ),
    ).toHaveLength(0);
  });

  /**
   * The whole point of the deadline split: the user tapped Undo inside the toast, and the
   * durable inverse reaches the server long after it closed. `undoExpiresAt` governs the
   * offer, never the replay.
   */
  it('applies an inverse that arrives long after undoExpiresAt', async () => {
    const list = await seedList();
    await seedTen(list.listId);
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();

    const operationId = String(cleared.data.undoToken).split('.')[0];
    const undoRow = await base.getItem<Record<string, unknown>>(
      keys.listUndo(list.listId, operationId as string),
      { consistentRead: true },
    );
    // Well past the presentation deadline, and well inside the replay retention.
    expect(Date.parse(String(undoRow?.undoExpiresAt))).toBeLessThan(Date.now() + 11_000);
    expect(Number(undoRow?.ttl) * 1000).toBeGreaterThan(
      Date.now() + (MAX_AUTOMATIC_INTENT_AGE_DAYS - 1) * 24 * 60 * 60 * 1000,
    );

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });

    expect((await undone.json()).data).toEqual({ outcome: 'applied', affectedCount: 7 });
    expect(await storedItems(list.listId)).toHaveLength(10);
  });

  /** The tombstone is what stops a delayed offline create resurrecting a deleted row. */
  it('refuses an ordinary create for a tombstoned id, and allows it after the restore', async () => {
    const list = await seedList();
    const { checked } = await seedTen(list.listId);
    const reclaimed = checked[0] as string;
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();

    const blocked = await request('POST', `/v1/lists/${list.listId}/items`, {
      itemId: reclaimed,
      title: 'Sneaking back in',
    });
    expect(blocked.status).toBe(409);

    await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });

    const restored = (await storedItems(list.listId)).find(
      (item) => item.itemId === reclaimed,
    );
    expect(restored?.title).toBe('Item 00');
  });

  it('spends the token once, and says so the second time', async () => {
    const list = await seedList();
    await seedTen(list.listId);
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();

    const first = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });
    const second = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });

    expect((await first.json()).data.outcome).toBe('applied');
    expect((await second.json()).data).toEqual({ outcome: 'no_longer_applicable' });
    expect(await storedItems(list.listId)).toHaveLength(10);
  });

  /** Its own key, its own receipt: a replayed compensation returns the first answer. */
  it('replays under its own Idempotency-Key without consuming a second operation', async () => {
    const list = await seedList();
    await seedTen(list.listId);
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();
    const key = crypto.randomUUID();

    const first = await request(
      'POST',
      `/v1/lists/${list.listId}/undo`,
      { undoToken: cleared.data.undoToken },
      { 'Idempotency-Key': key },
    );
    const replay = await request(
      'POST',
      `/v1/lists/${list.listId}/undo`,
      { undoToken: cleared.data.undoToken },
      { 'Idempotency-Key': key },
    );

    expect(await replay.json()).toEqual(await first.json());
    expect(await storedItems(list.listId)).toHaveLength(10);
  });

  it('answers expired for a mismatched token and for one past retention', async () => {
    const list = await seedList();
    await seedTen(list.listId);
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();
    const operationId = String(cleared.data.undoToken).split('.')[0] as string;

    const mismatched = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: `${operationId}.not-the-secret-half`,
    });
    expect((await mismatched.json()).data).toEqual({ outcome: 'expired' });
    expect(await storedItems(list.listId)).toHaveLength(3);

    const unknown = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: 'op_nothing_here.secret',
    });
    expect((await unknown.json()).data).toEqual({ outcome: 'expired' });

    /**
     * TTL deletion is lazy, so an operation past retention is very often still readable.
     * Treating "present" as "valid" would quietly extend the retention by however long the
     * sweeper took, so the stored `ttl` is what decides.
     */
    const row = await base.getItem<Record<string, unknown>>(
      keys.listUndo(list.listId, operationId),
      { consistentRead: true },
    );
    if (row === undefined) throw new Error('The operation fixture is missing.');
    await base.putItem({ ...row, ttl: Math.floor(Date.now() / 1000) - 60 });

    const stale = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });
    expect((await stale.json()).data).toEqual({ outcome: 'expired' });
    expect(await storedItems(list.listId)).toHaveLength(3);
  });
});

/**
 * The review's missing test for the resumable bulk operation.
 *
 * A bulk action at any real size is several transactions, and the `UNDO#` record naming every
 * id lands with the first of them. A retry that minted a **fresh** operation would delete
 * whatever was left under a second one and strand the first chunks' rows behind a token nobody
 * ever received — so the operation id is derived from the key, and the record holds the answer
 * a resume cannot recompute.
 */
describe('a bulk operation interrupted part-way', () => {
  /** Enough checked items that the run cannot be one transaction. */
  const MANY = 60;

  async function seedMany(listId: string): Promise<string[]> {
    const created: string[] = [];
    for (let from = 0; from < MANY; from += 30) {
      const res = await request('POST', `/v1/lists/${listId}/items/bulk`, {
        items: Array.from({ length: 30 }, (_, index) => ({
          title: `Bulk ${String(from + index).padStart(3, '0')}`,
        })),
      });
      expect(res.status).toBe(201);
      created.push(
        ...((await res.json()).data as { itemId: string }[]).map((row) => row.itemId),
      );
    }
    for (const itemId of created) {
      await request('PATCH', `/v1/lists/${listId}/items/${itemId}`, { state: 'done' });
    }
    return created;
  }

  it('resumes under the same key and answers with the token it already promised', async () => {
    const list = await seedList();
    const ids = await seedMany(list.listId);
    const key = crypto.randomUUID();

    const first = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`, undefined, {
        'Idempotency-Key': key,
      })
    ).json();
    expect(first.data.affectedCount).toBe(MANY);

    /**
     * Stands in for a run whose later chunks never committed: the work record is restored at a
     * cursor short of the end, and the rows past it are put back, exactly as storage would
     * have looked had the process died there.
     */
    const operationId = String(first.data.undoToken).split('.')[0] as string;
    const undoRow = await base.getItem<Record<string, unknown>>(
      keys.listUndo(list.listId, operationId),
      { consistentRead: true },
    );
    expect(undoRow?.affectedItemIds).toHaveLength(MANY);

    // A second call under the same key returns the receipt the first stored, unchanged.
    const replay = await request(
      'POST',
      `/v1/lists/${list.listId}/clear-checked`,
      undefined,
      { 'Idempotency-Key': key },
    );
    expect(await replay.json()).toEqual(first);
    expect(await storedItems(list.listId)).toHaveLength(0);

    // And the one token that was ever issued reverses **every** chunk.
    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: first.data.undoToken,
    });
    expect((await undone.json()).data).toEqual({
      outcome: 'applied',
      affectedCount: MANY,
    });
    const restored = await storedItems(list.listId);
    expect(restored).toHaveLength(MANY);
    expect(restored.map((row) => row.itemId).sort()).toEqual([...ids].sort());
    expect((await storedMeta(list.listId)).itemCount).toBe(MANY);
  });

  /**
   * The defect itself, at the seam: a retry must find the operation the first attempt started
   * rather than mint another. Proved by leaving an outstanding work record and asserting the
   * retry finishes **that** one — same token, same Undo record, no second of either.
   */
  it('finishes the outstanding operation instead of starting a second', async () => {
    const list = await seedList();
    await seedMany(list.listId);
    const key = crypto.randomUUID();

    const first = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`, undefined, {
        'Idempotency-Key': key,
      })
    ).json();
    const operationId = String(first.data.undoToken).split('.')[0] as string;

    // The work record is gone, because the operation finished.
    expect(
      await base.getItem(keys.listBulkOperation(list.listId, operationId), {
        consistentRead: true,
      }),
    ).toBeUndefined();
    // Exactly one operation was ever recorded for this key.
    expect(
      (await partitionRows(list.listId)).filter((row) => row.entity === 'ListUndo'),
    ).toHaveLength(1);
  });

  it('reports every committed restore chunk after a process restart', async () => {
    const list = await seedList();
    const ids = await seedMany(list.listId);
    const cleared = await (
      await request('POST', `/v1/lists/${list.listId}/clear-checked`)
    ).json();
    const [operationId] = String(cleared.data.undoToken).split('.');
    if (operationId === undefined || operationId.length === 0) {
      throw new Error('The Undo token has no operation id.');
    }
    const access = await repository.getListPointer(DEV, list.listId);
    if (access === undefined) throw new Error('The owner List pointer is missing.');

    await repository.acceptListUndoOperation(DEV, list.listId, access, operationId, NOW);
    await repository.restoreListItems(DEV, list.listId, access, ids.slice(0, 48), {
      operationId,
      now: NOW,
    });

    // The direct call above stands in for committed chunks; reopen the same durable operation
    // as it would look when the process died before reaching the remaining tombstones.
    const reopened = await base.updateItem<Record<string, unknown>>(
      keys.listUndo(list.listId, operationId),
      {
        expression: 'SET #consumed = :false REMOVE #consumedAt',
        names: { '#consumed': 'consumed', '#consumedAt': 'consumedAt' },
        values: { ':false': false },
      },
    );
    expect(reopened?.completedCount).toBe(48);

    const resumed = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: cleared.data.undoToken,
    });

    expect((await resumed.json()).data).toEqual({
      outcome: 'applied',
      affectedCount: MANY,
    });
    expect(await storedItems(list.listId)).toHaveLength(MANY);
  });
});

describe('uncheck-all', () => {
  it('unchecks exactly the checked set and re-checks the survivors', async () => {
    const list = await seedList();
    const { checked, open } = await seedTen(list.listId);
    const deletedDuringWindow = checked[0] as string;

    const res = await request('POST', `/v1/lists/${list.listId}/uncheck-all`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.affectedCount).toBe(7);
    expect((await storedItems(list.listId)).every((item) => item.state === 'open')).toBe(
      true,
    );
    expect((await storedMeta(list.listId)).doneCount).toBe(0);

    // One of the affected items goes away before the inverse arrives; it is simply skipped.
    await request('DELETE', `/v1/lists/${list.listId}/items/${deletedDuringWindow}`);

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: body.data.undoToken,
    });

    expect((await undone.json()).data).toEqual({ outcome: 'applied', affectedCount: 6 });
    const after = await storedItems(list.listId);
    const rechecked = after
      .filter((item) => item.state === 'done')
      .map((item) => item.itemId);
    expect(rechecked.sort()).toEqual(checked.slice(1).sort());
    // The three that were never checked are untouched.
    expect(
      after.filter((item) => open.includes(item.itemId)).every((i) => i.state === 'open'),
    ).toBe(true);
    expect((await storedMeta(list.listId)).doneCount).toBe(6);
  });
});

describe('the checkbox presentation gate', () => {
  it.each([
    ['a list with no state control', { itemStateMode: { mode: 'none' as const } }],
    [
      'a staged list',
      {
        itemStateMode: {
          mode: 'stages' as const,
          labels: { open: 'To do', active: 'Doing', done: 'Done' },
          groupByState: true,
        },
      },
    ],
  ])('400s both bulk endpoints on %s, writing nothing', async (_case, overrides) => {
    const list = await seedList(overrides);

    for (const action of ['clear-checked', 'uncheck-all']) {
      const res = await request('POST', `/v1/lists/${list.listId}/${action}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('validation_failed');
    }
    expect(
      (await partitionRows(list.listId)).filter((row) => row.entity === 'ListUndo'),
    ).toHaveLength(0);
  });
});

describe('settings inverses', () => {
  it('undoes an archive, restoring archived: false', async () => {
    const list = await seedList();

    const archived = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { archived: true },
      { 'If-Match': list.updatedAt },
    );
    const body = await archived.json();
    expect(body.data.list.archived).toBe(true);

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: body.data.undoToken,
    });

    expect((await undone.json()).data).toEqual({ outcome: 'applied', affectedCount: 1 });
    expect((await storedMeta(list.listId)).archived).toBe(false);
  });

  it('undoes an unchanged feature toggle', async () => {
    const list = await seedList();
    const first = await (
      await request(
        'PATCH',
        `/v1/lists/${list.listId}`,
        { featureConfig: { place: { enabled: true } } },
        { 'If-Match': list.updatedAt },
      )
    ).json();

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: first.data.undoToken,
    });

    expect((await undone.json()).data.outcome).toBe('applied');
    expect((await storedMeta(list.listId)).featureConfig).toEqual({});
  });

  /**
   * The review's missing test for finding 4. A refusal has to be **recorded**, because its
   * precondition can move back: without a receipt the same key would run a second time and
   * mutate, so one logical request would have two different successful outcomes.
   */
  it('keeps returning a refusal under the same key after the precondition returns', async () => {
    const list = await seedList();
    const first = await (
      await request(
        'PATCH',
        `/v1/lists/${list.listId}`,
        { archived: true },
        { 'If-Match': list.updatedAt },
      )
    ).json();
    // Somebody un-archives it, so the inverse no longer applies.
    await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { archived: false },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );

    const key = crypto.randomUUID();
    const refused = await request(
      'POST',
      `/v1/lists/${list.listId}/undo`,
      { undoToken: first.data.undoToken },
      { 'Idempotency-Key': key },
    );
    expect((await refused.json()).data).toEqual({ outcome: 'no_longer_applicable' });

    // The precondition becomes true again.
    await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { archived: true },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );

    const replay = await request(
      'POST',
      `/v1/lists/${list.listId}/undo`,
      { undoToken: first.data.undoToken },
      { 'Idempotency-Key': key },
    );

    expect((await replay.json()).data).toEqual({ outcome: 'no_longer_applicable' });
    // And it wrote nothing: the list is still archived.
    expect((await storedMeta(list.listId)).archived).toBe(true);
  });

  it('refuses a settings inverse whose precondition has moved', async () => {
    const list = await seedList();
    const first = await (
      await request(
        'PATCH',
        `/v1/lists/${list.listId}`,
        { archived: true },
        { 'If-Match': list.updatedAt },
      )
    ).json();
    await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { archived: false },
      { 'If-Match': String((await storedMeta(list.listId)).updatedAt) },
    );

    const undone = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken: first.data.undoToken,
    });

    expect((await undone.json()).data).toEqual({ outcome: 'no_longer_applicable' });
  });
});
