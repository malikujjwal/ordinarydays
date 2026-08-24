import { GetCommand } from '@aws-sdk/lib-dynamodb';
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
const NOW = '2026-08-24T09:00:00.000Z';

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
        ...(method === 'POST' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** Seeds a list directly: P3-09 owns `PATCH /v1/lists/:id`, so capabilities are set here. */
async function seedList(overrides: Partial<List> = {}): Promise<List> {
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
    expect(body.data.checked).toBe(false);
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
    expect(meta?.uncheckedCount).toBe(3);
  });

  it('400s the 501st item with exactly "List is full."', async () => {
    const list = await seedList({ itemCount: 500, uncheckedCount: 500 });

    const res = await addItem(list.listId, { title: 'One too many' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.message).toBe('List is full.');
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
 * Acceptance criterion 18: **both halves** of each gate, on every behaviour. A stored flag
 * left behind by a behaviour change must not resurrect a control the renderer does not have.
 */
describe('the two-part capability gates', () => {
  it('refuses checked on a collection with checkable off, and accepts it once on', async () => {
    const off = await seedList({
      capabilities: { checkable: false, supportsLocation: false },
    });
    const created = await (await addItem(off.listId, { title: 'Eggs' })).json();
    const itemId = created.data.itemId as string;

    const refused = await request(
      app(),
      'PATCH',
      `/v1/lists/${off.listId}/items/${itemId}`,
      { checked: true },
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.details?.[0]?.path).toBe('checked');

    // The same list with the capability on — the gate is the row's flag, not a template key.
    const on = await seedList({
      capabilities: { checkable: true, supportsLocation: false },
    });
    const there = await (await addItem(on.listId, { title: 'Eggs' })).json();
    const accepted = await request(
      app(),
      'PATCH',
      `/v1/lists/${on.listId}/items/${there.data.itemId}`,
      { checked: true },
    );
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data.checked).toBe(true);
    expect((await metaOf(on.listId))?.uncheckedCount).toBe(0);
  });

  it.each(['watch', 'meals'] as const)(
    'refuses checked on a %s list even with the stored flag true',
    async (behaviour) => {
      const list = await seedList({
        behaviour,
        templateKey: behaviour === 'watch' ? 'watchlist' : 'meals-to-try',
        // Retained from a previous collection generation, and meaningless here.
        capabilities: { checkable: true, supportsLocation: true },
      });
      const details =
        behaviour === 'watch'
          ? { behaviour: 'watch', watchStatus: 'want' }
          : { behaviour: 'meals' };
      const created = await (
        await addItem(list.listId, { title: 'Severance', details })
      ).json();

      const res = await request(
        app(),
        'PATCH',
        `/v1/lists/${list.listId}/items/${created.data.itemId}`,
        { checked: true },
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error.details?.[0]?.path).toBe('checked');
    },
  );

  it('refuses a location when supportsLocation is off, and accepts it when on', async () => {
    const off = await seedList();
    const refused = await addItem(off.listId, {
      title: 'Zahav',
      location: { label: 'Zahav' },
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.details?.[0]?.path).toBe('location');

    const on = await seedList({
      capabilities: { checkable: true, supportsLocation: true },
    });
    const accepted = await addItem(on.listId, {
      title: 'Zahav',
      location: { label: 'Zahav', address: '237 St James Pl' },
    });
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).data.location.label).toBe('Zahav');
  });

  it('refuses a location on watch and meals even with the stored flag true', async () => {
    const list = await seedList({
      behaviour: 'watch',
      templateKey: 'watchlist',
      capabilities: { checkable: true, supportsLocation: true },
    });

    const res = await addItem(list.listId, {
      title: 'Severance',
      details: { behaviour: 'watch', watchStatus: 'want' },
      location: { label: 'Sofa' },
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('location');
  });

  it('refuses details whose discriminant does not match the list behaviour', async () => {
    const watch = await seedList({ behaviour: 'watch', templateKey: 'watchlist' });

    const wrong = await addItem(watch.listId, {
      title: 'Chicken tacos',
      details: { behaviour: 'meals' },
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.details?.[0]?.path).toBe('details.behaviour');

    // And a collection carries no details shape at all.
    const collection = await seedList();
    const none = await addItem(collection.listId, {
      title: 'Severance',
      details: { behaviour: 'watch', watchStatus: 'want' },
    });
    expect(none.status).toBe(400);
  });

  it('retains a hidden value rather than clearing it', async () => {
    const list = await seedList({
      capabilities: { checkable: true, supportsLocation: true },
    });
    const created = await (
      await addItem(list.listId, { title: 'Zahav', location: { label: 'Zahav' } })
    ).json();

    // The capability goes off underneath the item, as a later settings change would do.
    await repository.patchListMeta(
      DEV,
      list.listId,
      (await repository.getListPointer(DEV, list.listId)) as never,
      { capabilities: { checkable: true, supportsLocation: false } },
      NOW,
      '2026-08-24T10:00:00.000Z',
    );

    const item = await request(
      app(),
      'GET',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
    );
    expect((await item.json()).data.location.label).toBe('Zahav');
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
    const list = await seedList({ itemCount: 499, uncheckedCount: 499 });

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

  it('400s a reorder mixed with a field edit rather than half-applying it', async () => {
    const list = await seedList();
    const created = await (await addItem(list.listId, { title: 'Eggs' })).json();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${created.data.itemId}`,
      { title: 'Milk', afterItemId: null },
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.details?.[0]?.path).toBe('afterItemId');
    expect((await itemsOf(list.listId))[0]?.title).toBe('Eggs');
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
