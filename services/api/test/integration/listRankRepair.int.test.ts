import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * The exceptional rank-repair worker (§P3-03, P3-08), end to end against DynamoDB Local.
 *
 * P3-04 already proves the repository *signals* the two triggers — an equal-rank run and a
 * gap subdivided past the length cap — without allocating. What is proved here is what the
 * worker does with that signal: that a caller never sees a half-repaired list, that a
 * bounded request resumes rather than restarting, and that the order survives it.
 */

type AppModule = typeof import('../../src/app.js');
type Repository = typeof import('../../src/repositories/listRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type RepairService = typeof import('../../src/services/listRankRepairService.js');

let createApp: AppModule['createApp'];
let repository: Repository;
let base: Base;
let keys: Keys;
let repair: RepairService;

const DEV = 'usr_local_dev';
const NOW = '2026-08-24T09:00:00.000Z';
const LATER = '2026-08-24T09:05:00.000Z';

/** `MAX_DRAIN_CHUNKS` (8) × `RANK_REPAIR_CHUNK` (25). One request cannot exceed this. */
const ONE_REQUEST_OF_REPAIR = 200;

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  repository = await import('../../src/repositories/listRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  repair = await import('../../src/services/listRankRepairService.js');
});

const app = () => createApp();

const request = (method: string, path: string, body?: unknown) =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

async function seedList(): Promise<List> {
  const list: List = {
    listId: repository.newListId(),
    ownerId: DEV,
    behaviour: 'collection',
    templateKey: 'checklist',
    title: 'Errands',
    icon: 'check-square',
    emptyStateCopy: 'Add something to check off.',
    capabilities: { checkable: true, supportsLocation: false },
    slot: null,
    itemCount: 0,
    uncheckedCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: NOW,
    lastItemActivityAt: NOW,
  };
  await repository.createList(DEV, list, { now: NOW });
  return list;
}

const accessFor = async (listId: string) => {
  const grant = await repository.getListPointer(DEV, listId);
  if (grant === undefined) throw new Error('List fixture has no access grant.');
  return grant;
};

/** Every item, straight from storage, in stored sort-key order. */
async function storedItems(listId: string): Promise<ListItem[]> {
  const prefix = keys.listItemPrefix(listId);
  const rows = await base.queryAll<Record<string, unknown>>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  return rows as unknown as ListItem[];
}

async function addItems(listId: string, count: number, offset = 0): Promise<void> {
  const items = Array.from({ length: count }, (_, index) => ({
    title: `Item ${String(index + offset).padStart(3, '0')}`,
  }));
  const res = await request('POST', `/v1/lists/${listId}/items/bulk`, { items });
  expect(res.status).toBe(201);
}

/** Collapses one item onto its predecessor's rank — an Undo-restored or legacy duplicate. */
async function forceEqualRanks(listId: string): Promise<void> {
  const items = await storedItems(listId);
  const first = items[0];
  const second = items[1];
  if (first === undefined || second === undefined) {
    throw new Error('Equal-rank fixture needs at least two items.');
  }
  await base.deleteItem(keys.listItem(listId, second.rank, second.itemId));
  await base.putItem({
    entity: 'ListItem',
    // The row is spread **before** the key, because `storedItems` returns raw rows carrying
    // their own `pk`/`sk`; spreading it after would put the row back at its old sort key
    // with a new rank attribute, which is a corruption the fixture is not trying to make.
    ...second,
    ...keys.listItem(listId, first.rank, second.itemId),
    rank: first.rank,
    createdAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
  });
  await base.updateItem(keys.listItemLocator(listId, second.itemId), {
    expression: 'SET #rank = :rank',
    names: { '#rank': 'rank' },
    values: { ':rank': first.rank },
  });
}

describe('repairing an equal-rank run', () => {
  it('repairs, then completes the insert that could not allocate', async () => {
    const list = await seedList();
    await addItems(list.listId, 4);
    await forceEqualRanks(list.listId);
    const before = await storedItems(list.listId);
    const anchor = before[0];
    if (anchor === undefined) throw new Error('No anchor item.');

    const res = await request('POST', `/v1/lists/${list.listId}/items`, {
      title: 'After the duplicate',
      afterItemId: anchor.itemId,
    });

    expect(res.status).toBe(201);
    const after = await storedItems(list.listId);
    expect(after).toHaveLength(5);
    // Every rank distinct again, which is what the repair was for.
    expect(new Set(after.map((item) => item.rank)).size).toBe(5);
  });

  it('advances rankVersion once the marker clears, invalidating older cursors', async () => {
    const list = await seedList();
    await addItems(list.listId, 3);
    const access = await accessFor(list.listId);
    const before = await repository.getListMeta(DEV, list.listId, access);

    const cleared = await repair.repairListRanks(DEV, list.listId, access, LATER);

    expect(cleared).toBe(true);
    const after = await repository.getListMeta(DEV, list.listId, access);
    expect(after?.rankVersion).toBe((before?.rankVersion ?? 0) + 1);
    expect(after?.rankRepairId).toBeUndefined();
  });
});

describe('a repair too large for one request', () => {
  /**
   * The invariant that matters: **no page is ever served while work remains.** The list is
   * sized past one request's bounded drain, so the first read cannot finish the repair and
   * must refuse rather than serve rows from two rank generations.
   */
  it('refuses every page until the work is done, then serves the repaired list', async () => {
    const list = await seedList();
    const total = ONE_REQUEST_OF_REPAIR + 60;
    await addItems(list.listId, total);
    const titles = (await storedItems(list.listId)).map((item) => item.title);

    const access = await accessFor(list.listId);
    const operationId = repository.newListOperationId();
    const work = await repository.beginRankRepair(DEV, list.listId, access, {
      operationId,
      now: LATER,
    });
    expect(work.entries).toHaveLength(total);

    // The first request drains 200 of 260 and still has work, so it refuses rather than
    // serving rows from two rank generations. The exact-id read refuses for the same reason.
    const refused = await request('GET', `/v1/lists/${list.listId}/items`);
    expect(refused.status).toBe(503);
    expect(refused.headers.get('Retry-After')).toBe('1');
    expect((await refused.json()).error.code).toBe('internal');

    // The marker still stands, and the work resumed rather than restarting.
    const meta = await repository.getListMeta(DEV, list.listId, access);
    expect(meta?.rankRepairId).toBe(operationId);
    expect((await repository.getRankRepairWork(list.listId, operationId))?.cursor).toBe(
      ONE_REQUEST_OF_REPAIR,
    );

    // The next request finishes the remaining 60 and serves the page.
    const served = await request('GET', `/v1/lists/${list.listId}/items`);
    expect(served.status).toBe(200);
    expect((await repository.getListMeta(DEV, list.listId, access))?.rankRepairId).toBe(
      undefined,
    );

    // Every item exactly once, in the order it was in before the rewrite.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await request(
        'GET',
        `/v1/lists/${list.listId}/items${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      );
      expect(page.status).toBe(200);
      const body = await page.json();
      seen.push(...body.data.map((entry: { item: ListItem }) => entry.item.title));
      cursor = body.meta.nextCursor;
    } while (cursor !== undefined);

    expect(seen).toEqual(titles);
    expect(new Set(seen).size).toBe(total);
  });

  it('resumes from the stored cursor rather than restarting the snapshot', async () => {
    const list = await seedList();
    await addItems(list.listId, 30);
    const access = await accessFor(list.listId);
    const operationId = repository.newListOperationId();

    const work = await repository.beginRankRepair(DEV, list.listId, access, {
      operationId,
      now: LATER,
    });
    expect(work.entries).toHaveLength(30);

    const afterOne = await repository.applyRankRepairChunk(work);
    expect(afterOne.cursor).toBe(25);
    const stored = await repository.getRankRepairWork(list.listId, operationId);
    // The cursor advance commits with the chunk, so a crash here resumes at entry 25.
    expect(stored?.cursor).toBe(25);

    const afterTwo = await repository.applyRankRepairChunk(afterOne);
    expect(afterTwo.cursor).toBe(30);
    await repository.finishRankRepair(afterTwo);

    expect(
      (await repository.getRankRepairWork(list.listId, operationId)) === undefined,
    ).toBe(true);
    expect((await repository.getListMeta(DEV, list.listId, access))?.rankRepairId).toBe(
      undefined,
    );
  });
});

describe('cursors across a repair', () => {
  it('refuses a cursor issued before the rewrite, so page one restarts cleanly', async () => {
    const list = await seedList();
    await addItems(list.listId, 60);

    const first = await request('GET', `/v1/lists/${list.listId}/items`);
    const cursor = (await first.json()).meta.nextCursor as string;
    expect(typeof cursor).toBe('string');

    const access = await accessFor(list.listId);
    expect(await repair.repairListRanks(DEV, list.listId, access, LATER)).toBe(true);

    const stale = await request(
      'GET',
      `/v1/lists/${list.listId}/items?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(stale.status).toBe(503);
    expect(stale.headers.get('Retry-After')).toBe('1');

    // Page one is serviceable immediately, and still holds every item.
    const restart = await request('GET', `/v1/lists/${list.listId}/items`);
    expect(restart.status).toBe(200);
    expect((await restart.json()).data).toHaveLength(50);
  });
});

describe('the repair itself', () => {
  it('preserves order and item count, and leaves every rank distinct', async () => {
    const list = await seedList();
    await addItems(list.listId, 40);
    const before = await storedItems(list.listId);

    const access = await accessFor(list.listId);
    await repair.repairListRanks(DEV, list.listId, access, LATER);

    const after = await storedItems(list.listId);
    expect(after.map((item) => item.title)).toEqual(before.map((item) => item.title));
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((item) => item.rank)).size).toBe(after.length);
    // Counters are untouched: a repair moves rows, it does not add or remove them.
    expect((await repository.getListMeta(DEV, list.listId, access))?.itemCount).toBe(40);
  });

  it('moves every locator with its row, so the exact read still resolves', async () => {
    const list = await seedList();
    await addItems(list.listId, 5);
    const before = await storedItems(list.listId);
    const target = before[2];
    if (target === undefined) throw new Error('No target item.');

    const access = await accessFor(list.listId);
    await repair.repairListRanks(DEV, list.listId, access, LATER);

    const res = await request('GET', `/v1/lists/${list.listId}/items/${target.itemId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.title).toBe(target.title);
    expect(body.data.rank).not.toBe(target.rank);
  });

  it('is a no-op to call when no marker stands', async () => {
    const list = await seedList();
    await addItems(list.listId, 3);
    const access = await accessFor(list.listId);

    expect(await repair.drainRankRepair(DEV, list.listId, access, LATER)).toBe(true);
    expect((await repository.getListMeta(DEV, list.listId, access))?.rankVersion).toBe(1);
  });
});

/**
 * The window that would otherwise brick a list: the marker is down, and the snapshot the
 * worker needs does not exist yet. Because the two are written in one transaction, that
 * state is *recoverable* rather than terminal — the record is present and `snapshotting`,
 * and any later caller finishes it under the gate.
 */
describe('a repair interrupted before its snapshot', () => {
  it('commits the marker and its work record together, never one alone', async () => {
    const list = await seedList();
    await addItems(list.listId, 4);
    const access = await accessFor(list.listId);
    const operationId = repository.newListOperationId();

    await repository.beginRankRepair(DEV, list.listId, access, {
      operationId,
      now: LATER,
    });

    // Whatever a crash interrupts, a marker never names a record that is not there.
    const meta = await repository.getListMeta(DEV, list.listId, access);
    expect(meta?.rankRepairId).toBe(operationId);
    expect(await repository.getRankRepairWork(list.listId, operationId)).toBeDefined();
  });

  it('finishes a snapshot the installer never filled, rather than gating forever', async () => {
    const list = await seedList();
    await addItems(list.listId, 5);
    const access = await accessFor(list.listId);
    const operationId = repository.newListOperationId();
    const titles = (await storedItems(list.listId)).map((item) => item.title);

    // Exactly the state a crash between the install and the snapshot leaves behind. The
    // recorded version must be the list's current one, since the final transaction
    // condition-checks it before clearing the marker.
    const before = await repository.getListMeta(DEV, list.listId, access);
    await base.putItem({
      ...keys.listRankRepair(list.listId, operationId),
      entity: 'ListRankRepair',
      listId: list.listId,
      operationId,
      state: 'snapshotting',
      entries: [],
      cursor: 0,
      rankVersion: before?.rankVersion ?? 0,
      createdAt: LATER,
      updatedAt: LATER,
      schemaVersion: 1,
    });
    await base.updateItem(keys.listMeta(list.listId), {
      expression: 'SET #rankRepairId = :operationId',
      names: { '#rankRepairId': 'rankRepairId' },
      values: { ':operationId': operationId },
    });

    // A page read is refused, drains the stranded work, and the list comes back whole.
    expect(await repair.drainRankRepair(DEV, list.listId, access, LATER)).toBe(true);

    const after = await repository.getListMeta(DEV, list.listId, access);
    expect(after?.rankRepairId).toBeUndefined();
    expect((await storedItems(list.listId)).map((item) => item.title)).toEqual(titles);
    const served = await request('GET', `/v1/lists/${list.listId}/items`);
    expect(served.status).toBe(200);
  });

  it('makes a concurrent second start drain the winner rather than snapshot again', async () => {
    const list = await seedList();
    await addItems(list.listId, 6);
    const access = await accessFor(list.listId);
    const titles = (await storedItems(list.listId)).map((item) => item.title);

    const [first, second] = await Promise.all([
      repair.repairListRanks(DEV, list.listId, access, LATER),
      repair.repairListRanks(DEV, list.listId, access, LATER),
    ]);

    expect(first).toBe(true);
    expect(second).toBe(true);
    const after = await repository.getListMeta(DEV, list.listId, access);
    expect(after?.rankRepairId).toBeUndefined();
    // One repair happened, not two: order and count are untouched and ranks are distinct.
    const items = await storedItems(list.listId);
    expect(items.map((item) => item.title)).toEqual(titles);
    expect(new Set(items.map((item) => item.rank)).size).toBe(items.length);
  });
});
