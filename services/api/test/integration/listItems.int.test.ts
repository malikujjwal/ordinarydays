import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { instant } from '@od/shared/schemas';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * ListItem CRUD through the real app, against DynamoDB Local (§P3-08's test list).
 *
 * The rank mechanics themselves — the four-action reorder, two inserts converging on one
 * gap, the field-patch/reorder race, the strong page fence — are P3-04's, already covered in
 * `listRepository.int.test.ts` at the seam that owns them. What is new here is the endpoint
 * behaviour: the caps and gates, ordered bulk, and the durable-replay guarantees.
 *
 * **Deferred, recorded not dropped:** §P3-08's SQLite/outbox remap tests — an explicit Retry
 * atomically remapping a local item and every dependent outbox reference — are the native
 * client's and belong to P3-25/P3-27. They cannot be exercised from the API side.
 */

type AppModule = typeof import('../../src/app.js');
type Repository = typeof import('../../src/repositories/listRepository.js');

let createApp: AppModule['createApp'];
let repository: Repository;

const DEV = 'usr_local_dev';
const BEN = 'usr_int_items_ben';
const NOW = instant.parse('2026-08-24T09:00:00.000Z');

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
  repository = await import('../../src/repositories/listRepository.js');
});

const app = () => createApp();
const asBen = () =>
  createApp({ identityProvider: { resolve: () => Promise.resolve(BEN) } });

type Json = Record<string, unknown>;

const request = (
  application: ReturnType<AppModule['createApp']>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  application.fetch(
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

/** Seeds a canonical list directly so each item test controls its feature gates. */
async function seedList(overrides: Partial<List> = {}): Promise<List> {
  const list: List = {
    schemaVersion: 2,
    listId: repository.newListId(),
    ownerId: DEV,
    templateKey: 'checklist',
    title: 'Errands',
    icon: 'check-square',
    emptyStateCopy: 'Add something to check off.',
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

const addItem = async (
  listId: string,
  body: Json,
  headers: Record<string, string> = {},
) => request(app(), 'POST', `/v1/lists/${listId}/items`, body, headers);

const itemsOf = async (listId: string): Promise<ListItem[]> => {
  const res = await request(app(), 'GET', `/v1/lists/${listId}/items`);
  expect(res.status).toBe(200);
  const body = await res.json();
  return (body.data as { item: ListItem }[]).map((entry) => entry.item);
};

const metaOf = async (listId: string) =>
  (
    await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `LIST#${listId}`, sk: 'META' },
        ConsistentRead: true,
      }),
    )
  ).Item;

describe('creating an item', () => {
  it('201s with the item, and never leaks the storage-only revision fence', async () => {
    const list = await seedList();

    const res = await addItem(list.listId, { title: 'Eggs' });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.title).toBe('Eggs');
    expect(body.data.state).toBe('open');
    expect(body.data.itemId).toMatch(/^itm_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data).not.toHaveProperty('itemRevision');
    expect(body.data).not.toHaveProperty('pk');
  });

  it('places each item after the one named, and advances the counters', async () => {
    const list = await seedList();
    const first = await (await addItem(list.listId, { title: 'One' })).json();
    const third = await (await addItem(list.listId, { title: 'Three' })).json();
    await addItem(list.listId, {
      title: 'Two',
      afterItemId: first.data.itemId,
    });

    expect((await itemsOf(list.listId)).map((item) => item.title)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
    expect(third.data.itemId).toBeDefined();
    const meta = await metaOf(list.listId);
    expect(meta?.itemCount).toBe(3);
    expect(meta?.doneCount).toBe(0);
  });

  it('400s the 501st item with exactly "List is full."', async () => {
    const list = await seedList({ itemCount: 500, doneCount: 0 });

    const res = await addItem(list.listId, { title: 'One too many' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('List is full.');
  });

  /**
   * **The cap is a transaction condition, not a precheck.** From a genuine 499 rows, two
   * concurrent creates both pass the service's read; without the condition on META the
   * loser's retry — against a refreshed `rankVersion` that says nothing about capacity —
   * commits item 501.
   */
  it('lets exactly one of two concurrent creates through at 499 real items', async () => {
    const list = await seedList();
    // A real 499 rows, not a seeded counter: the condition reads the stored count.
    for (let from = 0; from < 499; from += 250) {
      const size = Math.min(250, 499 - from);
      const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
        items: Array.from({ length: size }, (_, index) => ({
          title: `Seed ${String(from + index).padStart(3, '0')}`,
        })),
      });
      expect(res.status).toBe(201);
    }
    expect((await metaOf(list.listId))?.itemCount).toBe(499);

    const [first, second] = await Promise.all([
      addItem(list.listId, { title: 'Race A' }),
      addItem(list.listId, { title: 'Race B' }),
    ]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([201, 400]);
    const refused = first.status === 400 ? first : second;
    expect((await refused.json()).error.message).toBe('List is full.');
    expect((await metaOf(list.listId))?.itemCount).toBe(500);
  });

  it('404s a stranger without revealing the list', async () => {
    const list = await seedList();

    const res = await request(asBen(), 'POST', `/v1/lists/${list.listId}/items`, {
      title: 'Not mine',
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });
});

/**
 * Each typed feature is independently gated, and disabling one retains stored values.
 */
describe('feature gates and retained values', () => {
  it('refuses a disabled place and accepts it once enabled', async () => {
    const off = await seedList({ featureConfig: {} });
    const refused = await addItem(off.listId, {
      title: 'Zahav',
      features: { place: { label: 'Zahav' } },
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.details?.[0]?.path).toBe('features.place');

    const on = await seedList({ featureConfig: { place: { enabled: true } } });
    const accepted = await addItem(on.listId, {
      title: 'Zahav',
      features: { place: { label: 'Zahav', address: '237 St James Pl' } },
    });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).data.features.place.label).toBe('Zahav');
  });

  it('refuses a progress value whose kind differs from the list configuration', async () => {
    const list = await seedList({
      featureConfig: { progress: { enabled: true, kind: 'text' } },
    });
    const res = await addItem(list.listId, {
      title: 'Severance',
      features: { progress: { kind: 'episode', episode: 4 } },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('features.progress.kind');
  });

  it('retains a feature value byte-identically when the feature is disabled', async () => {
    const list = await seedList({ featureConfig: { place: { enabled: true } } });
    const place = { label: 'Zahav', address: '237 St James Pl' };
    const created = await (
      await addItem(list.listId, { title: 'Zahav', features: { place } })
    ).json();
    await repository.patchListMeta(
      DEV,
      list.listId,
      (await repository.getListPointer(DEV, list.listId)) as never,
      { featureConfig: { place: { enabled: false } } },
      NOW,
      '2026-08-24T10:00:00.000Z',
    );

    const item = await request(
      app(),
      'GET',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
    );
    expect((await item.json()).data.features.place).toEqual(place);
  });

  it('refuses to clear a hidden feature, so disabling cannot destroy its value', async () => {
    const list = await seedList({ featureConfig: { place: { enabled: true } } });
    const created = await (
      await addItem(list.listId, {
        title: 'Zahav',
        features: { place: { label: 'Zahav' } },
      })
    ).json();
    await repository.patchListMeta(
      DEV,
      list.listId,
      (await repository.getListPointer(DEV, list.listId)) as never,
      { featureConfig: { place: { enabled: false } } },
      NOW,
      '2026-08-24T10:00:00.000Z',
    );

    const refused = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      { features: { place: null } },
    );
    expect(refused.status).toBe(400);
    const after = await request(
      app(),
      'GET',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
    );
    expect((await after.json()).data.features.place.label).toBe('Zahav');
  });
});

describe('bulk creation', () => {
  it('writes thirty items in the order they were sent', async () => {
    const list = await seedList();
    const items = Array.from({ length: 30 }, (_, index) => ({
      title: `Item ${String(index).padStart(2, '0')}`,
    }));

    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items,
    });

    expect(res.status).toBe(201);
    expect((await res.json()).data).toHaveLength(30);
    expect((await itemsOf(list.listId)).map((item) => item.title)).toEqual(
      items.map((item) => item.title),
    );
    expect((await metaOf(list.listId))?.itemCount).toBe(30);
  });

  it('spans chunks in order when the batch exceeds one transaction', async () => {
    const list = await seedList();
    // Above the 32-item transaction budget, so this is a resumable chunked sequence.
    const items = Array.from({ length: 40 }, (_, index) => ({
      title: `Item ${String(index).padStart(2, '0')}`,
    }));

    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items,
    });

    expect(res.status).toBe(201);
    expect((await itemsOf(list.listId)).map((item) => item.title)).toEqual(
      items.map((item) => item.title),
    );
  });

  it('creates no duplicate on a same-key replay', async () => {
    const list = await seedList();
    const key = crypto.randomUUID();
    const body = { items: [{ title: 'Eggs' }, { title: 'Milk' }] };

    const first = await request(
      app(),
      'POST',
      `/v1/lists/${list.listId}/items/bulk`,
      body,
      { 'Idempotency-Key': key },
    );
    const replay = await request(
      app(),
      'POST',
      `/v1/lists/${list.listId}/items/bulk`,
      body,
      { 'Idempotency-Key': key },
    );

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await itemsOf(list.listId)).toHaveLength(2);
  });

  /**
   * The guarantee that outlives the 24-hour receipt: a fresh key replaying the same stable
   * ids reconciles what is already committed instead of duplicating it.
   */
  it('creates no duplicate when stable ids are replayed under a fresh key', async () => {
    const list = await seedList();
    const body = {
      items: [
        { itemId: repository.newItemId(), title: 'Eggs' },
        { itemId: repository.newItemId(), title: 'Milk' },
      ],
    };

    await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, body);
    const replay = await request(
      app(),
      'POST',
      `/v1/lists/${list.listId}/items/bulk`,
      body,
    );

    expect(replay.status).toBe(201);
    const stored = await itemsOf(list.listId);
    expect(stored).toHaveLength(2);
    expect(stored.map((item) => item.title)).toEqual(['Eggs', 'Milk']);
    expect((await metaOf(list.listId))?.itemCount).toBe(2);
  });

  /**
   * Capacity is measured against the rows the call would **add**, after resolving what is
   * already committed. Measuring the submitted array instead would reject the very retry
   * that is meant to finish a batch whose earlier chunk already landed.
   */
  it('resumes a >32-item batch near the cap instead of rejecting its own retry', async () => {
    const list = await seedList();
    const ids = Array.from({ length: 40 }, () => repository.newItemId());
    const members = ids.map((itemId, index) => ({
      itemId,
      title: `Item ${String(index).padStart(2, '0')}`,
    }));
    // 460 rows already there: the 40-item batch exactly reaches the cap…
    await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: Array.from({ length: 460 }, (_, index) => ({
        title: `Seed ${String(index).padStart(3, '0')}`,
      })),
    });
    // …and its first chunk of 32 lands, as a crashed attempt would have left it.
    await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: members.slice(0, 32),
    });
    expect((await metaOf(list.listId))?.itemCount).toBe(492);

    // The retry re-sends all 40. Only the eight missing may count against the cap.
    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: members,
    });

    expect(res.status).toBe(201);
    expect((await metaOf(list.listId))?.itemCount).toBe(500);
    // And the response reconciles every requested identity, in the order they were sent.
    const body = await res.json();
    expect(body.data.map((item: ListItem) => item.itemId)).toEqual(ids);
  });

  it('answers a fully committed replay with server truth, not an empty array', async () => {
    const list = await seedList();
    const members = [
      { itemId: repository.newItemId(), title: 'Eggs' },
      { itemId: repository.newItemId(), title: 'Milk' },
    ];
    const first = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: members,
    });
    const firstBody = await first.json();

    // A fresh key, so the middleware replays nothing and the service reconciles by id.
    const replay = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: members,
    });
    const replayBody = await replay.json();

    expect(replay.status).toBe(201);
    expect(replayBody.data).toHaveLength(2);
    expect(replayBody.data.map((item: ListItem) => item.itemId)).toEqual(
      members.map((member) => member.itemId),
    );
    // Byte-for-byte the canonical rows, ranks included.
    expect(replayBody.data).toEqual(firstBody.data);
    expect((await metaOf(list.listId))?.itemCount).toBe(2);
  });

  it('completes a partially committed batch rather than duplicating it', async () => {
    const list = await seedList();
    const ids = [repository.newItemId(), repository.newItemId(), repository.newItemId()];
    // The first item lands on its own, as a crashed chunk would have left it.
    await request(app(), 'POST', `/v1/lists/${list.listId}/items`, {
      itemId: ids[0],
      title: 'Eggs',
    });

    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: [
        { itemId: ids[0], title: 'Eggs' },
        { itemId: ids[1], title: 'Milk' },
        { itemId: ids[2], title: 'Bread' },
      ],
    });

    expect(res.status).toBe(201);
    const stored = await itemsOf(list.listId);
    expect(stored.map((item) => item.title)).toEqual(['Eggs', 'Milk', 'Bread']);
    expect((await metaOf(list.listId))?.itemCount).toBe(3);
  });

  it('400s a batch that would cross the 500-item cap, writing nothing', async () => {
    const list = await seedList({ itemCount: 499, doneCount: 0 });

    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: [{ title: 'One' }, { title: 'Two' }],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('List is full.');
    expect(await itemsOf(list.listId)).toHaveLength(0);
  });

  it('400s a position on any member but the first', async () => {
    const list = await seedList();
    const anchor = await (await addItem(list.listId, { title: 'Anchor' })).json();

    const res = await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: [
        { title: 'One', afterItemId: anchor.data.itemId },
        { title: 'Two', afterItemId: anchor.data.itemId },
      ],
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('items.1.afterItemId');
  });
});

describe('patching an item', () => {
  it('applies only the supplied fields and leaves the rest byte-identical', async () => {
    const list = await seedList();
    const created = await (
      await addItem(list.listId, { title: 'Eggs', note: 'a dozen' })
    ).json();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      { title: 'Free-range eggs' },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.title).toBe('Free-range eggs');
    expect(body.data.note).toBe('a dozen');
    expect(body.data.rank).toBe(created.data.rank);
  });

  it('clears a field with null, which is different from omitting it', async () => {
    const list = await seedList();
    const created = await (
      await addItem(list.listId, { title: 'Eggs', note: 'a dozen' })
    ).json();

    const cleared = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      { note: null },
    );

    expect((await cleared.json()).data).not.toHaveProperty('note');
  });

  /** Criterion 16, at the endpoint: a drag writes one logical item and bumps the version. */
  it('reorders in one transaction of four domain actions, advancing rankVersion', async () => {
    const list = await seedList();
    const titles = ['One', 'Two', 'Three'];
    const created: string[] = [];
    for (const title of titles) {
      const res = await addItem(list.listId, { title });
      created.push((await res.json()).data.itemId);
    }
    const versionBefore = (await metaOf(list.listId))?.rankVersion as number;

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created[2]}`,
      { afterItemId: null },
    );

    expect(res.status).toBe(200);
    expect((await itemsOf(list.listId)).map((item) => item.title)).toEqual([
      'Three',
      'One',
      'Two',
    ]);
    expect((await metaOf(list.listId))?.rankVersion).toBe(versionBefore + 1);
    expect((await metaOf(list.listId))?.itemCount).toBe(3);
  });

  /**
   * A position and ordinary fields arrive together and land together — one transaction, so
   * a client that dragged a row and renamed it cannot end up with the rename applied and
   * the move lost.
   */
  it('applies a field edit and a move in the same write', async () => {
    const list = await seedList();
    const first = await (await addItem(list.listId, { title: 'One' })).json();
    await addItem(list.listId, { title: 'Two' });
    const third = await (await addItem(list.listId, { title: 'Three' })).json();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${third.data.itemId}`,
      { title: 'Third, renamed', state: 'done', afterItemId: null },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.title).toBe('Third, renamed');
    expect(body.data.state).toBe('done');
    expect((await itemsOf(list.listId)).map((item) => item.title)).toEqual([
      'Third, renamed',
      'One',
      'Two',
    ]);
    // The folded-in state change still moves the counter.
    expect((await metaOf(list.listId))?.doneCount).toBe(1);
    expect(first.data.itemId).toBeDefined();
  });

  it('refuses a folded-in feature the list does not enable', async () => {
    const list = await seedList({ featureConfig: {} });
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      { features: { place: { label: 'Shop' } }, afterItemId: null },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('features.place');
  });

  it('404s an item that is not on this list', async () => {
    const list = await seedList();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${repository.newItemId()}`,
      { title: 'Ghost' },
    );

    expect(res.status).toBe(404);
  });
});

describe('deleting an item', () => {
  it('200s with the Undo offer and removes the row', async () => {
    const list = await seedList();
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();

    const res = await request(
      app(),
      'DELETE',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.affectedCount).toBe(1);
    expect(typeof body.data.undoToken).toBe('string');
    expect(Date.parse(body.data.undoExpiresAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await itemsOf(list.listId)).toHaveLength(0);
    expect((await metaOf(list.listId))?.itemCount).toBe(0);
  });

  it('stores only the token hash, never the token', async () => {
    const list = await seedList();
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();

    const body = await (
      await request(
        app(),
        'DELETE',
        `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      )
    ).json();

    const partition = await repository.getListMeta(
      DEV,
      list.listId,
      (await repository.getListPointer(DEV, list.listId)) as never,
    );
    expect(partition).toBeDefined();
    const undoRows = await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `LIST#${list.listId}`, sk: 'META' },
      }),
    );
    expect(JSON.stringify(undoRows.Item)).not.toContain(body.data.undoToken);
  });

  it('leaves a tombstone that an ordinary create cannot reuse', async () => {
    const list = await seedList();
    const itemId = repository.newItemId();
    await addItem(list.listId, { itemId, title: 'Eggs' });
    await request(app(), 'DELETE', `/v1/lists/${list.listId}/items/${itemId}`);

    const res = await addItem(list.listId, { itemId, title: 'Eggs again' });

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(
      'That id is already in use. Try again.',
    );
  });

  it('404s the second call, exactly as a missing item does', async () => {
    const list = await seedList();
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();
    const path = `/v1/lists/${list.listId}/items/${created.data.itemId}`;

    expect((await request(app(), 'DELETE', path)).status).toBe(200);
    expect((await request(app(), 'DELETE', path)).status).toBe(404);
  });
});

describe('the exact-id read, which durable creation reconciles against', () => {
  it('200s and adopts the server row after a lost response', async () => {
    const list = await seedList();
    const itemId = repository.newItemId();
    await addItem(list.listId, { itemId, title: 'Eggs' });

    const res = await request(app(), 'GET', `/v1/lists/${list.listId}/items/${itemId}`);

    expect(res.status).toBe(200);
    expect((await res.json()).data.itemId).toBe(itemId);
  });

  it('404s a missing id and a tombstoned one alike', async () => {
    const list = await seedList();
    const missing = repository.newItemId();
    const deleted = repository.newItemId();
    await addItem(list.listId, { itemId: deleted, title: 'Eggs' });
    await request(app(), 'DELETE', `/v1/lists/${list.listId}/items/${deleted}`);

    expect(
      (await request(app(), 'GET', `/v1/lists/${list.listId}/items/${missing}`)).status,
    ).toBe(404);
    expect(
      (await request(app(), 'GET', `/v1/lists/${list.listId}/items/${deleted}`)).status,
    ).toBe(404);
  });

  it('404s a foreign caller, so a guessed id confirms nothing', async () => {
    const list = await seedList();
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();

    const res = await request(
      asBen(),
      'GET',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
    );

    expect(res.status).toBe(404);
  });
});

describe('paging items', () => {
  it('returns fifty at a time with a cursor, and every item exactly once', async () => {
    const list = await seedList();
    const titles = Array.from(
      { length: 60 },
      (_, index) => `Item ${String(index).padStart(2, '0')}`,
    );
    await request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
      items: titles.map((title) => ({ title })),
    });

    const first = await request(app(), 'GET', `/v1/lists/${list.listId}/items`);
    const firstBody = await first.json();
    expect(firstBody.data).toHaveLength(50);
    expect(typeof firstBody.meta.nextCursor).toBe('string');

    const second = await request(
      app(),
      'GET',
      `/v1/lists/${list.listId}/items?cursor=${encodeURIComponent(firstBody.meta.nextCursor)}`,
    );
    const secondBody = await second.json();
    expect(secondBody.data).toHaveLength(10);
    expect(secondBody.meta.nextCursor).toBeUndefined();

    const seen = [...firstBody.data, ...secondBody.data].map(
      (entry: { item: ListItem }) => entry.item.title,
    );
    expect(seen).toEqual(titles);
  });

  it('400s a malformed cursor', async () => {
    const list = await seedList();

    const res = await request(
      app(),
      'GET',
      `/v1/lists/${list.listId}/items?cursor=%23%23`,
    );

    expect(res.status).toBe(400);
  });
});

/**
 * **The two timestamps, and every writer that must move the right one** (P3-47).
 *
 * `updatedAt` backs `If-Match` and moves only when the List row itself changes.
 * `lastItemActivityAt` moves when any **item** changes and backs nothing — the Lists index
 * renders it (`design-system.md` §7.2).
 *
 * ## Why every route is covered rather than a representative few
 *
 * A missed writer is invisible. Nothing throws, no assertion elsewhere fails, and no user
 * reports it: the card just quietly says `Updated 3 days ago` about a list they used this
 * morning. The only way that surfaces is a test per write path, which is what this is —
 * and the reason the loop below is written out per route rather than as one clever helper
 * is that a helper is a place a route can be forgotten.
 */
describe('the two timestamps (P3-47)', () => {
  /** Both stored values, read from the META row the Lists index batch-reads. */
  const stampsOf = async (listId: string) => {
    const meta = (await metaOf(listId)) as {
      updatedAt: string;
      lastItemActivityAt: string;
    };
    return { updatedAt: meta.updatedAt, lastItemActivityAt: meta.lastItemActivityAt };
  };

  const seedItem = async (listId: string, title = 'Milk'): Promise<ListItem> => {
    const res = await addItem(listId, { title });
    expect(res.status).toBe(201);
    return (await res.json()).data as ListItem;
  };

  it('seeds lastItemActivityAt equal to createdAt on a fresh list', async () => {
    const created = await request(app(), 'POST', '/v1/lists', {
      title: 'Errands',
      templateKey: 'checklist',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()).data as {
      listId: string;
      updatedAt: string;
      lastItemActivityAt: string;
    };

    // A list nobody has added to has been "last used" when it was made — and the index
    // renders this field, so leaving it unset would give a fresh card nothing to say.
    expect(body.lastItemActivityAt).toBe(body.updatedAt);
    const stored = await stampsOf(body.listId);
    expect(stored.lastItemActivityAt).toBe(stored.updatedAt);
  });

  /** It is a display value, so it has to reach the client. */
  it('serialises on the list response', async () => {
    const list = await seedList();
    const res = await request(app(), 'GET', `/v1/lists/${list.listId}`);
    const body = (await res.json()).data as { list: Record<string, unknown> };

    expect(body.list.lastItemActivityAt).toBe(NOW);
  });

  /**
   * **The canonical pair**, and the one §P3-47 names first: completing an item moves the
   * display timestamp and leaves the concurrency token byte-identical.
   */
  it('completing an item moves lastItemActivityAt and leaves updatedAt byte-identical', async () => {
    const list = await seedList();
    const item = await seedItem(list.listId);
    const before = await stampsOf(list.listId);

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${item.itemId}`,
      { state: 'done' },
    );
    expect(res.status).toBe(200);

    const after = await stampsOf(list.listId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(Date.parse(after.lastItemActivityAt)).toBeGreaterThan(
      Date.parse(before.lastItemActivityAt),
    );
  });

  /** And the reverse, which is the half that proves the two are not the same field. */
  it('renaming the list moves updatedAt and leaves lastItemActivityAt byte-identical', async () => {
    const list = await seedList();
    await seedItem(list.listId);
    const before = await stampsOf(list.listId);

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}`,
      { title: 'Weekend errands' },
      { 'If-Match': before.updatedAt },
    );
    expect(res.status).toBe(200);

    const after = await stampsOf(list.listId);
    expect(after.lastItemActivityAt).toBe(before.lastItemActivityAt);
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  });

  /**
   * **The regression the whole split exists to prevent.**
   *
   * An item write must not refresh the token an open settings sheet is holding. If it did,
   * a stale `If-Match` would start *succeeding* after somebody completed an item — which
   * is a lost update, and one nothing else in the suite would catch.
   */
  it('still fails a stale If-Match after an unrelated item write', async () => {
    const list = await seedList();
    const item = await seedItem(list.listId);
    const held = (await stampsOf(list.listId)).updatedAt;

    // The list is renamed by someone else, so the held token is now stale…
    const renamed = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}`,
      { title: 'Renamed' },
      { 'If-Match': held },
    );
    expect(renamed.status).toBe(200);

    // …and an ordinary item write lands in between, which must not rehabilitate it.
    await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
      state: 'done',
    });

    const stale = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}`,
      { title: 'Renamed again' },
      { 'If-Match': held },
    );
    expect(stale.status).toBe(409);
  });

  describe('every item write path moves it', () => {
    /** Runs `write`, and answers what each timestamp did. */
    const around = async (
      listId: string,
      // `app.fetch` is typed `Response | Promise<Response>`; awaiting covers both.
      write: () => Response | Promise<Response>,
    ): Promise<{
      status: number;
      itemActivityMoved: boolean;
      updatedAtMoved: boolean;
    }> => {
      const before = await stampsOf(listId);
      const res = await write();
      const after = await stampsOf(listId);
      return {
        status: res.status,
        itemActivityMoved: after.lastItemActivityAt !== before.lastItemActivityAt,
        updatedAtMoved: after.updatedAt !== before.updatedAt,
      };
    };

    it('create', async () => {
      const list = await seedList();
      const result = await around(list.listId, () =>
        addItem(list.listId, { title: 'Eggs' }),
      );

      expect(result.status).toBe(201);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });

    it('bulk create — once for the batch', async () => {
      const list = await seedList();
      const result = await around(list.listId, () =>
        request(app(), 'POST', `/v1/lists/${list.listId}/items/bulk`, {
          items: [{ title: 'Eggs' }, { title: 'Milk' }, { title: 'Bread' }],
        }),
      );

      expect(result.status).toBe(201);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });

    it('field patch', async () => {
      const list = await seedList();
      const item = await seedItem(list.listId);
      const result = await around(list.listId, () =>
        request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
          note: 'Semi-skimmed',
        }),
      );

      expect(result.status).toBe(200);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });

    it('reorder', async () => {
      const list = await seedList();
      const first = await seedItem(list.listId, 'Eggs');
      const second = await seedItem(list.listId, 'Milk');
      const result = await around(list.listId, () =>
        request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${first.itemId}`, {
          afterItemId: second.itemId,
        }),
      );

      expect(result.status).toBe(200);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });

    it('delete', async () => {
      const list = await seedList();
      const item = await seedItem(list.listId);
      const result = await around(list.listId, () =>
        request(app(), 'DELETE', `/v1/lists/${list.listId}/items/${item.itemId}`),
      );

      expect(result.status).toBe(200);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });

    it('uncheck-all', async () => {
      const list = await seedList();
      const item = await seedItem(list.listId);
      await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
        state: 'done',
      });

      const result = await around(list.listId, () =>
        request(app(), 'POST', `/v1/lists/${list.listId}/uncheck-all`, {}),
      );

      expect(result.status).toBe(200);
      expect(result.itemActivityMoved).toBe(true);
      expect(result.updatedAtMoved).toBe(false);
    });
  });

  /**
   * **Once for the operation, not once per item** (§P3-47's edge case). Every chunk of one
   * request writes the identical instant, so a three-item clear moves the field to exactly
   * one value rather than to whichever chunk committed last.
   */
  it('clear-checked bumps once, however many items it deletes', async () => {
    const list = await seedList();
    for (const title of ['Eggs', 'Milk', 'Bread']) {
      const item = await seedItem(list.listId, title);
      await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
        state: 'done',
      });
    }
    const before = await stampsOf(list.listId);

    const res = await request(
      app(),
      'POST',
      `/v1/lists/${list.listId}/clear-checked`,
      {},
    );
    expect(res.status).toBe(200);

    const after = await stampsOf(list.listId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastItemActivityAt).not.toBe(before.lastItemActivityAt);
    // All three deletions committed under one instant — the request's, not a per-chunk one.
    expect((await metaOf(list.listId))?.itemCount).toBe(0);
  });

  /**
   * **Undo bumps it again**, and §P3-47 says why in one line: the list did change, twice.
   * Restoring three deleted items is as much a change to the list as deleting them was.
   */
  it('undo of a bulk operation bumps it a second time', async () => {
    const list = await seedList();
    const item = await seedItem(list.listId);
    await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
      state: 'done',
    });

    const cleared = await request(
      app(),
      'POST',
      `/v1/lists/${list.listId}/clear-checked`,
      {},
    );
    const { undoToken } = (await cleared.json()).data as { undoToken: string };
    const afterClear = await stampsOf(list.listId);

    const undone = await request(app(), 'POST', `/v1/lists/${list.listId}/undo`, {
      undoToken,
    });
    expect(undone.status).toBe(200);

    const afterUndo = await stampsOf(list.listId);
    expect(afterUndo.updatedAt).toBe(afterClear.updatedAt);
    expect(Date.parse(afterUndo.lastItemActivityAt)).toBeGreaterThanOrEqual(
      Date.parse(afterClear.lastItemActivityAt),
    );
    expect(afterUndo.lastItemActivityAt).not.toBe(NOW);
    expect((await metaOf(list.listId))?.itemCount).toBe(1);
  });

  /**
   * **The list-level writes, which must move the other one.** A settings change and an
   * archive are changes to the List row; a card should say the list was changed, and an open
   * settings sheet holding a stale token should conflict.
   */
  it.each([
    ['a presentation change', { itemStateMode: { mode: 'none' } }],
    ['an archive', { archived: true }],
  ])('%s moves updatedAt and not lastItemActivityAt', async (_label, patch) => {
    const list = await seedList();
    await seedItem(list.listId);
    const before = await stampsOf(list.listId);

    const res = await request(app(), 'PATCH', `/v1/lists/${list.listId}`, patch, {
      'If-Match': before.updatedAt,
    });
    expect(res.status).toBe(200);

    const after = await stampsOf(list.listId);
    expect(after.lastItemActivityAt).toBe(before.lastItemActivityAt);
    expect(after.updatedAt).not.toBe(before.updatedAt);
  });
});
