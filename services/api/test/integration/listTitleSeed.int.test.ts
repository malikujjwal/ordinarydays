import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Activity, List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * The one-time title seed and the independence that follows it (§P3-14, acceptance
 * criterion 9), plus the stale-pointer rule from `api-contract.md` §3.
 *
 * Mostly proof rather than new behaviour. The property under test throughout is that the
 * ListItem and the Plan are **two objects joined by a pointer**, not one object with two
 * names: the title crosses once, at creation, and never again in either direction. That is a
 * sharing boundary before it is a data rule — a member who may rename a shared item must
 * never rename another member's private Plan by doing so (`plans-and-lists.md` §6.1).
 *
 * "Byte-identical" is asserted against the **stored row**, not the response projection, so a
 * field that never reaches a client cannot drift unnoticed.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

const DEV = 'usr_local_dev';
const BEN = 'usr_int_seed_ben';

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT_TWO = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const BEN_ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X4';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
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

const rawItem = async (pk: string, sk: string) =>
  (
    await documents.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { pk, sk }, ConsistentRead: true }),
    )
  ).Item;

const storedItem = (item: ListItem) =>
  rawItem(`LIST#${item.listId}`, `ITEM#${item.rank}#${item.itemId}`);

const storedActivity = (activityId: string) => rawItem(`ACT#${activityId}`, 'META');

const storedLink = (listId: string, viewerUserId: string, itemId: string) =>
  rawItem(`LIST#${listId}`, `LNK#${viewerUserId}#${itemId}`);

const setUp = async (itemTitle = 'Zahav') => {
  const listRes = await request(app(), 'POST', '/v1/lists', {
    title: 'Restaurants',
    templateKey: 'restaurants-to-try',
  });
  expect(listRes.status).toBe(201);
  const list = (await listRes.json()).data as List;

  const itemRes = await request(app(), 'POST', `/v1/lists/${list.listId}/items`, {
    title: itemTitle,
  });
  expect(itemRes.status).toBe(201);
  return { list, item: (await itemRes.json()).data as ListItem };
};

const plan = async (
  listId: string,
  itemId: string,
  overrides: Json = {},
  application = app(),
) => {
  const res = await request(
    application,
    'POST',
    `/v1/lists/${listId}/items/${itemId}/schedule`,
    {
      activityId: ACT,
      creationTarget: { objectKind: 'plan', type: 'event' },
      audience: { mode: 'just_me' },
      ...overrides,
    },
  );
  expect(res.status).toBe(201);
  return (await res.json()).data.activity as Activity;
};

const detail = async (listId: string, application = app()) => {
  const res = await request(application, 'GET', `/v1/lists/${listId}?includeItems=true`);
  expect(res.status).toBe(200);
  return (await res.json()).data as { items: { item: Json; viewerLink?: Json }[] };
};

describe('the title crosses once, at creation', () => {
  it('copies the item title when the request omits one', async () => {
    const { list, item } = await setUp('Zahav');

    const created = await plan(list.listId, item.itemId);

    expect(created.title).toBe('Zahav');
    expect((await storedActivity(ACT))?.title).toBe('Zahav');
  });

  it('uses the supplied title instead when there is one', async () => {
    const { list, item } = await setUp('Zahav');

    const created = await plan(list.listId, item.itemId, { title: 'Dinner at Zahav' });

    expect(created.title).toBe('Dinner at Zahav');
    /** The item keeps its own name; the Plan's title is not written back to it. */
    expect((await storedItem(item))?.title).toBe('Zahav');
  });

  /** A copy, not a reference: renaming the item afterwards cannot reach the Plan. */
  it('copies rather than referencing — a later item rename does not follow', async () => {
    const { list, item } = await setUp('Zahav');
    await plan(list.listId, item.itemId);

    await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
      title: 'Zahav (Philadelphia)',
    });

    expect((await storedActivity(ACT))?.title).toBe('Zahav');
  });
});

describe('after creation the two objects are independent', () => {
  it('renaming the item leaves the Plan byte-identical', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    const before = await storedActivity(ACT);

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${item.itemId}`,
      { title: 'Somewhere else' },
    );

    expect(res.status).toBe(200);
    expect(await storedActivity(ACT)).toEqual(before);
  });

  it('renaming the Plan leaves the item byte-identical', async () => {
    const { list, item } = await setUp();
    const created = await plan(list.listId, item.itemId);
    const before = await storedItem(item);

    /** The Activity `PATCH` is the conditional one; the item `PATCH` deliberately is not. */
    const res = await request(
      app(),
      'PATCH',
      `/v1/activities/${ACT}`,
      { title: 'Dinner with Sam' },
      { 'If-Match': created.updatedAt },
    );

    expect(res.status).toBe(200);
    expect(created.title).toBe('Zahav');
    expect(await storedItem(item)).toEqual(before);
  });

  /** Notes were never seeded and must never mirror, in either direction. */
  it('never mirrors notes', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId, { notes: 'Book the tasting menu' });

    expect((await storedItem(item))?.note).toBeUndefined();

    await request(app(), 'PATCH', `/v1/lists/${list.listId}/items/${item.itemId}`, {
      note: 'Ask about the patio',
    });

    expect((await storedActivity(ACT))?.notes).toBe('Book the tasting menu');
  });
});

describe('two viewers, two Plans, one item', () => {
  /**
   * The sharing boundary the copy exists to protect. Ben's pointer and Plan are seeded
   * directly, because list membership arrives in Phase 6 — what matters here is that a rename
   * by the item's owner reaches neither Plan.
   */
  const seedBensPlan = async (listId: string, itemId: string) => {
    const created = await request(asBen(), 'POST', '/v1/activities', {
      activityId: BEN_ACT,
      objectKind: 'plan',
      type: 'event',
      title: 'Ben’s own night out',
    });
    expect(created.status).toBe(201);

    await documents.send(
      new PutCommand({
        TableName: TEST_TABLE,
        Item: {
          pk: `LIST#${listId}`,
          sk: `LNK#${BEN}#${itemId}`,
          entity: 'ListItemActivityLink',
          listId,
          itemId,
          viewerUserId: BEN,
          activityId: BEN_ACT,
          linkedAt: '2026-08-25T09:00:00.000Z',
          createdAt: '2026-08-25T09:00:00.000Z',
          updatedAt: '2026-08-25T09:00:00.000Z',
          schemaVersion: 1,
        },
      }),
    );
  };

  it('one item rename changes neither viewer’s Plan', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    await seedBensPlan(list.listId, item.itemId);
    const mine = await storedActivity(ACT);
    const bens = await storedActivity(BEN_ACT);

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${item.itemId}`,
      { title: 'Renamed by the list owner' },
    );

    expect(res.status).toBe(200);
    expect(await storedActivity(ACT)).toEqual(mine);
    expect(await storedActivity(BEN_ACT)).toEqual(bens);
  });

  /** A caller sees their own pointer and never the other viewer's (ADR-034). */
  it('shows each caller only their own pointer', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    await seedBensPlan(list.listId, item.itemId);

    const row = (await detail(list.listId)).items[0];

    expect(row?.viewerLink).toMatchObject({ viewerUserId: DEV, activityId: ACT });
  });
});

describe('replacing a pointer leaves the older Plan alone', () => {
  it('neither renames nor deletes the Plan it stopped pointing at', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    const older = await storedActivity(ACT);

    await plan(list.listId, item.itemId, { activityId: ACT_TWO, title: 'A second plan' });

    expect(await storedActivity(ACT)).toEqual(older);
    expect((await storedLink(list.listId, DEV, item.itemId))?.activityId).toBe(ACT_TWO);
  });
});

describe('a stale pointer is omitted, then removed', () => {
  const deleteThePlan = async () => {
    const res = await request(app(), 'DELETE', `/v1/activities/${ACT}`);
    expect(res.status).toBe(200);
  };

  it('omits the link, leaves the item byte-identical, and removes the row', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    const itemBefore = await storedItem(item);
    expect(await storedLink(list.listId, DEV, item.itemId)).toBeDefined();

    await deleteThePlan();

    /** The read that meets the stale pointer: no link, and the item untouched. */
    const first = (await detail(list.listId)).items[0];
    expect(first?.viewerLink).toBeUndefined();
    expect(await storedItem(item)).toEqual(itemBefore);

    /** The cleanup ran after that read, so the row is gone by the next one. */
    expect(await storedLink(list.listId, DEV, item.itemId)).toBeUndefined();
    const second = (await detail(list.listId)).items[0];
    expect(second?.viewerLink).toBeUndefined();
  });

  it('still lets the item be edited while its pointer is stale', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    await deleteThePlan();

    const res = await request(
      app(),
      'PATCH',
      `/v1/lists/${list.listId}/items/${item.itemId}`,
      { title: 'Still editable' },
    );

    expect(res.status).toBe(200);
    expect((await storedItem(item))?.title).toBe('Still editable');
  });

  /**
   * The condition on the delete. If the viewer schedules the item again between the read
   * that found the pointer stale and the cleanup that follows, the **new** pointer must
   * survive — deleting it would remove the link to a Plan they just made.
   */
  it('does not remove a pointer that was replaced in the meantime', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    await deleteThePlan();

    /** A fresh Plan lands on the same key before any cleanup pass has run. */
    await plan(list.listId, item.itemId, { activityId: ACT_TWO });
    await detail(list.listId);

    const link = await storedLink(list.listId, DEV, item.itemId);
    expect(link?.activityId).toBe(ACT_TWO);
  });

  /** Idempotent: a second pass over an already-removed pointer changes nothing. */
  it('is a no-op once the row is gone', async () => {
    const { list, item } = await setUp();
    await plan(list.listId, item.itemId);
    await deleteThePlan();
    await detail(list.listId);

    await documents.send(
      new DeleteCommand({
        TableName: TEST_TABLE,
        Key: { pk: `LIST#${list.listId}`, sk: `LNK#${DEV}#${item.itemId}` },
      }),
    );

    const again = (await detail(list.listId)).items[0];
    expect(again?.viewerLink).toBeUndefined();
    expect(await storedItem(item)).toBeDefined();
  });
});
