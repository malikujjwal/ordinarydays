import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * The completion follow-up, end to end against DynamoDB Local (§P3-16, acceptance
 * criterion 11).
 *
 * The claim under test is a **negative** one — that completing a watch session writes the
 * Activity and nothing else — and a negative claim about storage is exactly what a mock
 * cannot settle. So the list partition is snapshotted before the completion and compared
 * whole afterwards: a stray write anywhere in it fails, however it got there, including
 * one nobody thought to name a key for.
 *
 * The positive half is the second request. Confirming is an ordinary item `PATCH` the
 * client issues, so the flow here is the real one: complete, read the suggestion, send the
 * `PATCH` built from it, and read the stored item back.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT_TWO = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const LIST_TITLE = 'Movies and shows';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
});

const app = () => createApp();

type Json = Record<string, unknown>;

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

const createList = async (templateKey = 'tv-shows') => {
  const res = await request('POST', '/v1/lists', { title: LIST_TITLE, templateKey });
  expect(res.status).toBe(201);
  return (await res.json()).data as List;
};

const addItem = async (listId: string, title: string, details: Json) => {
  const res = await request('POST', `/v1/lists/${listId}/items`, { title, details });
  expect(res.status).toBe(201);
  return (await res.json()).data as ListItem;
};

/** The `Plan this item` bridge: one Activity, one caller pointer, the item untouched. */
const planItem = async (
  listId: string,
  itemId: string,
  overrides: Json = {},
  activityId = ACT,
) => {
  const res = await request('POST', `/v1/lists/${listId}/items/${itemId}/schedule`, {
    activityId,
    creationTarget: { objectKind: 'plan', type: 'watch' },
    audience: { mode: 'just_me' },
    details: { kind: 'watch', mediaTitle: 'Severance' },
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()).data as Json;
};

const complete = (activityId: string, body: Json = {}) =>
  request('POST', `/v1/activities/${activityId}/complete`, body);

const completed = async (activityId: string, body: Json = {}) => {
  const res = await complete(activityId, body);
  expect(res.status).toBe(200);
  return (await res.json()).data as Json;
};

/** Every row of one list, so a stray write cannot hide behind a targeted read. */
const listPartition = async (listId: string) =>
  (
    await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': `LIST#${listId}` },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

const activityPartition = async (activityId: string) =>
  (
    await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': `ACT#${activityId}` },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

const activityMeta = async (activityId: string) =>
  (
    await documents.send(
      new GetCommand({
        TableName: TEST_TABLE,
        Key: { pk: `ACT#${activityId}`, sk: 'META' },
        ConsistentRead: true,
      }),
    )
  ).Item;

/**
 * Every `Activity` row in the table, which is the only honest way to assert that no
 * follow-up path created a second one: a count of one known partition proves nothing about
 * a Plan written under an id the test never chose.
 */
const activityCount = async () => {
  const scanned = await documents.send(
    new ScanCommand({ TableName: TEST_TABLE, ConsistentRead: true }),
  );
  return (scanned.Items ?? []).filter((row) => row.entity === 'Activity').length;
};

const storedItem = async (listId: string, itemId: string) => {
  const res = await request('GET', `/v1/lists/${listId}/items/${itemId}`);
  expect(res.status).toBe(200);
  return (await res.json()).data as Json;
};

const show = (overrides: Json = {}) => ({
  behaviour: 'watch',
  mediaKind: 'show',
  watchStatus: 'want',
  season: 2,
  episode: 4,
  ...overrides,
});

/**
 * P3-31's progress-update mutation, written the way the client writes it: the whole
 * `details` body, because an item `details` patch is a replacement, with `want → watching`
 * applied **only** from `want`. What is asserted afterwards is the row the server stored.
 */
const confirm = (followUp: Json) => {
  const current = followUp.current as Json;
  const target = followUp.target as Json;
  return request('PATCH', `/v1/lists/${followUp.listId}/items/${followUp.itemId}`, {
    details: {
      behaviour: 'watch',
      ...(followUp.mediaKind === undefined ? {} : { mediaKind: followUp.mediaKind }),
      watchStatus: current.watchStatus === 'want' ? 'watching' : current.watchStatus,
      ...target,
    },
  });
};

describe('a completed show session offers the progress update it evidences', () => {
  const setUp = async (itemDetails: Json = show(), session: Json = {}) => {
    const list = await createList();
    const item = await addItem(list.listId, 'Severance', itemDetails);
    await planItem(list.listId, item.itemId, {
      details: {
        kind: 'watch',
        mediaTitle: 'Severance',
        mediaKind: 'show',
        season: 2,
        episode: 5,
        ...session,
      },
    });
    return { list, item };
  };

  it('leaves the item at S2 E4 and answers with the session’s S2 E5', async () => {
    const { list, item } = await setUp();

    const data = await completed(ACT);

    expect(data.activity).toMatchObject({ status: 'completed', outcome: 'watched' });
    expect(data.followUp).toEqual({
      kind: 'watch_progress',
      listId: list.listId,
      listTitle: LIST_TITLE,
      itemId: item.itemId,
      mediaKind: 'show',
      current: { watchStatus: 'want', season: 2, episode: 4 },
      target: { season: 2, episode: 5 },
    });
    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      details: show(),
    });
  });

  it('writes nothing at all in the list partition', async () => {
    const { list } = await setUp();
    const before = await listPartition(list.listId);

    await completed(ACT);

    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('advances the item to S2 E5 and to watching only once confirmed', async () => {
    const { list, item } = await setUp();
    const data = await completed(ACT);

    const res = await confirm(data.followUp as Json);

    expect(res.status).toBe(200);
    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      details: {
        behaviour: 'watch',
        mediaKind: 'show',
        watchStatus: 'watching',
        season: 2,
        episode: 5,
      },
    });
  });

  it('leaves an item already watching where it is on that axis', async () => {
    const { list, item } = await setUp(show({ watchStatus: 'watching' }));
    const data = await completed(ACT);

    await confirm(data.followUp as Json);

    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      details: expect.objectContaining({ watchStatus: 'watching', episode: 5 }),
    });
  });

  /**
   * A session covering ground the item has already seen is a **rewatch**, which
   * `plans-and-lists.md` §8.4 names as an ordinary case the user answers by dismissing.
   * The server does not decide the question is not worth asking.
   */
  it('still asks when the session repeats the item’s current progress', async () => {
    await setUp(show({ episode: 5 }));

    const data = await completed(ACT);

    expect(data.followUp).toMatchObject({
      current: { episode: 5 },
      target: { season: 2, episode: 5 },
    });
  });

  it('creates no second Activity, through the follow-up or the confirmation', async () => {
    await setUp();
    const data = await completed(ACT);

    await confirm(data.followUp as Json);

    expect(await activityCount()).toBe(1);
  });
});

describe('a completed movie session offers only the watched transition', () => {
  const setUp = async () => {
    const list = await createList('movies-to-watch');
    const item = await addItem(list.listId, 'Dune', {
      behaviour: 'watch',
      mediaKind: 'movie',
      watchStatus: 'want',
    });
    await planItem(list.listId, item.itemId, {
      details: { kind: 'watch', mediaTitle: 'Dune', mediaKind: 'movie' },
    });
    return { list, item };
  };

  it('targets watched, and completion sets nothing', async () => {
    const { list, item } = await setUp();

    const data = await completed(ACT);

    expect(data.followUp).toEqual({
      kind: 'watch_watched',
      listId: list.listId,
      listTitle: LIST_TITLE,
      itemId: item.itemId,
      mediaKind: 'movie',
      current: { watchStatus: 'want' },
      target: { watchStatus: 'watched' },
    });
    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'want' },
    });
  });

  it('reaches watched only through the confirming PATCH', async () => {
    const { list, item } = await setUp();
    const data = await completed(ACT);

    await confirm(data.followUp as Json);

    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'watched' },
    });
  });
});

/**
 * `CLAUDE.md` rule 3 and the risk row "Completion mutates watch progress or recurring
 * series META". One occurrence is one occurrence: it writes its own override, leaves the
 * series byte-identical, and offers nothing — the next occurrence already exists.
 */
describe('a recurring watch series', () => {
  const setUp = async () => {
    const list = await createList();
    const item = await addItem(list.listId, 'Severance', show());
    await planItem(list.listId, item.itemId, {
      schedule: { date: '2026-08-01', time: '20:00', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
      details: {
        kind: 'watch',
        mediaTitle: 'Severance',
        mediaKind: 'show',
        season: 2,
        episode: 5,
      },
    });
    return { list, item };
  };

  it('writes one occurrence override, leaves META byte-identical and offers nothing', async () => {
    const { list } = await setUp();
    const meta = await activityMeta(ACT);
    const listBefore = await listPartition(list.listId);

    const data = await completed(ACT, { occurrenceDate: '2026-08-08' });

    expect(data.followUp).toBeUndefined();
    expect(data.occurrence).toMatchObject({
      date: '2026-08-08',
      status: 'completed',
    });
    expect(await activityMeta(ACT)).toEqual(meta);
    expect(
      (await activityPartition(ACT))
        .filter((row) => row.entity === 'Occurrence')
        .map((row) => row.sk),
    ).toEqual(['OCC#2026-08-08']);
    expect(await listPartition(list.listId)).toEqual(listBefore);
  });

  it('rejects the same completion with no occurrenceDate, and writes nothing', async () => {
    await setUp();
    const meta = await activityMeta(ACT);

    const res = await complete(ACT);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details?.[0]?.path).toBe('occurrenceDate');
    expect(await activityMeta(ACT)).toEqual(meta);
    expect(
      (await activityPartition(ACT)).filter((row) => row.entity === 'Occurrence'),
    ).toEqual([]);
  });
});

describe('what silently offers nothing', () => {
  const linkedShow = async () => {
    const list = await createList();
    const item = await addItem(list.listId, 'Severance', show());
    await planItem(list.listId, item.itemId, {
      details: {
        kind: 'watch',
        mediaTitle: 'Severance',
        mediaKind: 'show',
        season: 2,
        episode: 5,
      },
    });
    return { list, item };
  };

  /**
   * §P3-16's edge case. Downgrading strips the typed `details`, so there is no progress to
   * describe — and describing it from a stale read would offer to restore fields the user
   * has just chosen to lose.
   */
  it('a list changed away from watch', async () => {
    const { list } = await linkedShow();
    const version = (
      (await (await request('GET', `/v1/lists/${list.listId}`)).json()).data as {
        list: { updatedAt: string };
      }
    ).list.updatedAt;
    const changed = await app().fetch(
      new Request(
        `http://localhost/v1/lists/${list.listId}/behaviour?confirmDataLoss=true`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': crypto.randomUUID(),
            'If-Match': version,
          },
          body: JSON.stringify({ behaviour: 'collection' }),
        },
      ),
    );
    expect(changed.status).toBe(200);

    expect((await completed(ACT)).followUp).toBeUndefined();
  });

  it('a deleted item', async () => {
    const { list, item } = await linkedShow();
    expect(
      (await request('DELETE', `/v1/lists/${list.listId}/items/${item.itemId}`)).status,
    ).toBe(200);

    expect((await completed(ACT)).followUp).toBeUndefined();
  });

  /**
   * The pointer decides, not the Activity's stored `listItemId`. Planning the item again
   * moves the caller's pointer to the newer Plan, and completing the superseded one must
   * not offer to advance progress on its behalf (ADR-034).
   */
  it('a session the caller’s pointer has since moved off', async () => {
    const { list, item } = await linkedShow();
    await planItem(
      list.listId,
      item.itemId,
      {
        details: {
          kind: 'watch',
          mediaTitle: 'Severance',
          mediaKind: 'show',
          season: 2,
          episode: 6,
        },
      },
      ACT_TWO,
    );

    expect((await completed(ACT)).followUp).toBeUndefined();
    expect((await completed(ACT_TWO)).followUp).toMatchObject({
      target: { season: 2, episode: 6 },
    });
  });

  it('a watch Plan that was never made from a list item', async () => {
    const res = await request('POST', '/v1/activities', {
      activityId: ACT,
      objectKind: 'plan',
      type: 'watch',
      title: 'Severance',
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 5 },
    });
    expect(res.status).toBe(201);

    expect((await completed(ACT)).followUp).toBeUndefined();
  });

  /**
   * A negative outcome is `skipped`, which P3-15 makes clear the caller's pointer. A session
   * that did not happen is not evidence about anything.
   */
  it('a session that did not happen', async () => {
    const { list } = await linkedShow();

    const data = await completed(ACT, { outcome: 'didnt_happen' });

    expect(data.activity).toMatchObject({ status: 'skipped' });
    expect(data.followUp).toBeUndefined();
    expect(
      (await listPartition(list.listId)).filter((row) =>
        String(row.sk).startsWith('LNK#'),
      ),
    ).toEqual([]);
  });

  it('a show whose session names neither a season nor an episode', async () => {
    const list = await createList();
    const item = await addItem(list.listId, 'Severance', show());
    await planItem(list.listId, item.itemId);

    expect((await completed(ACT)).followUp).toBeUndefined();
  });
});
