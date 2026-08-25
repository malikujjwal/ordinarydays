import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * `POST /v1/lists/:id/items/:itemId/schedule` through the real app, against DynamoDB Local
 * (§P3-13's test list).
 *
 * The one thing only a real table can settle is the one this endpoint is most likely to get
 * wrong: that the bridge **links** rather than duplicates. So the item row is read back
 * straight from storage and compared byte for byte, and the whole list partition is counted —
 * a second `ITEM#` row anywhere fails, however it got there.
 *
 * **Deferred, recorded not dropped:** §P3-13's offline projection and local arming lines —
 * that a bridge intent carrying two stable reminder ids projects and arms those same ids in
 * SQLite before replay — are the native client's and belong to P3-42/P3-25. They cannot be
 * exercised from the API side. What is testable here is the server half: the same ids arrive
 * as exactly two caller `REM#` rows, and a replay creates no third.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

const DEV = 'usr_local_dev';
const BEN = 'usr_int_schedule_ben';

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT_TWO = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const REM_A = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const REM_B = 'rem_01J8XKQ2M4N5P6R7S8T9V0W1X5';

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

const createList = async (title = 'Restaurants', templateKey = 'restaurants-to-try') => {
  const res = await request(app(), 'POST', '/v1/lists', { title, templateKey });
  expect(res.status).toBe(201);
  return (await res.json()).data as List;
};

const addItem = async (listId: string, title = 'Zahav') => {
  const res = await request(app(), 'POST', `/v1/lists/${listId}/items`, { title });
  expect(res.status).toBe(201);
  return (await res.json()).data as ListItem;
};

const schedule = (
  listId: string,
  itemId: string,
  body: Json,
  headers: Record<string, string> = {},
  application = app(),
) =>
  request(
    application,
    'POST',
    `/v1/lists/${listId}/items/${itemId}/schedule`,
    body,
    headers,
  );

const validBody = (overrides: Json = {}): Json => ({
  activityId: ACT,
  creationTarget: { objectKind: 'plan', type: 'event' },
  audience: { mode: 'just_me' },
  ...overrides,
});

/** Every row in one partition, so a stray write cannot hide behind a targeted read. */
const partition = async (pk: string) =>
  (
    await documents.send(
      new QueryCommand({
        TableName: TEST_TABLE,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': 'pk' },
        ExpressionAttributeValues: { ':pk': pk },
        ConsistentRead: true,
      }),
    )
  ).Items ?? [];

const rawItem = async (pk: string, sk: string) =>
  (
    await documents.send(
      new GetCommand({ TableName: TEST_TABLE, Key: { pk, sk }, ConsistentRead: true }),
    )
  ).Item;

const setUp = async () => {
  const list = await createList();
  const item = await addItem(list.listId);
  return { list, item };
};

describe('the bridge links rather than duplicates', () => {
  it('writes one Plan, one index entry and one caller link, and leaves the item alone', async () => {
    const { list, item } = await setUp();
    const before = await rawItem(
      `LIST#${list.listId}`,
      `ITEM#${item.rank}#${item.itemId}`,
    );

    const res = await schedule(list.listId, item.itemId, validBody());

    expect(res.status).toBe(201);
    const body = (await res.json()).data as Json;
    expect(body.activity).toMatchObject({
      activityId: ACT,
      objectKind: 'plan',
      type: 'event',
      listId: list.listId,
      listItemId: item.itemId,
    });

    const activityRows = await partition(`ACT#${ACT}`);
    expect(activityRows.filter((row) => row.sk === 'META')).toHaveLength(1);

    const userRows = await partition(`USER#${DEV}`);
    expect(userRows.filter((row) => String(row.sk).startsWith('IDX#'))).toHaveLength(1);

    const listRows = await partition(`LIST#${list.listId}`);
    expect(listRows.filter((row) => String(row.sk).startsWith('LNK#'))).toHaveLength(1);

    /** The item, byte for byte. Not copied, moved, checked, hidden or given an id. */
    const after = await rawItem(
      `LIST#${list.listId}`,
      `ITEM#${item.rank}#${item.itemId}`,
    );
    expect(after).toEqual(before);
    expect(listRows.filter((row) => String(row.sk).startsWith('ITEM#'))).toHaveLength(1);
  });

  it('returns the item and the caller’s own link in the response', async () => {
    const { list, item } = await setUp();

    const body = (await (await schedule(list.listId, item.itemId, validBody())).json())
      .data as Json;

    expect(body.item).toMatchObject({
      itemId: item.itemId,
      title: 'Zahav',
      checked: false,
    });
    expect(body.item).not.toHaveProperty('itemRevision');
    expect(body.viewerLink).toMatchObject({
      listId: list.listId,
      itemId: item.itemId,
      viewerUserId: DEV,
      activityId: ACT,
    });
  });

  it('leaks no storage attribute', async () => {
    const { list, item } = await setUp();

    const body = (await (await schedule(list.listId, item.itemId, validBody())).json())
      .data as Json;

    for (const part of [body.activity, body.item, body.viewerLink]) {
      expect(part).not.toHaveProperty('pk');
      expect(part).not.toHaveProperty('sk');
      expect(part).not.toHaveProperty('entity');
    }
  });
});

describe('the Plan kind follows the request, never the list', () => {
  /**
   * Acceptance criterion 7 and `CLAUDE.md` rule 2. The same title, every Plan kind, against a
   * `watch` list whose behaviour would be the obvious thing to infer from — and never is.
   */
  it.each(['meal', 'watch', 'event', 'custom'])(
    'stores %s when the request asks for it, against a watch list',
    async (type) => {
      const list = await createList('Watchlist', 'watchlist');
      const item = await addItem(list.listId, 'Severance');

      const res = await schedule(
        list.listId,
        item.itemId,
        validBody({
          activityId: ACT,
          creationTarget: { objectKind: 'plan', type },
          ...(type === 'watch'
            ? { details: { kind: 'watch', mediaTitle: 'Severance' } }
            : {}),
        }),
      );

      expect(res.status).toBe(201);
      expect((await res.json()).data.activity).toMatchObject({
        objectKind: 'plan',
        type,
      });
    },
  );

  it('copies the item title once when the request omits one', async () => {
    const { list, item } = await setUp();

    const res = await schedule(list.listId, item.itemId, validBody());

    expect((await res.json()).data.activity.title).toBe('Zahav');
  });

  it('uses the supplied title instead when there is one', async () => {
    const { list, item } = await setUp();

    const res = await schedule(
      list.listId,
      item.itemId,
      validBody({ title: 'Dinner at Zahav' }),
    );

    expect((await res.json()).data.activity.title).toBe('Dinner at Zahav');
  });
});

describe('what it refuses, and writes nothing for', () => {
  const noPlanWritten = async (listId: string) => {
    expect(await partition(`ACT#${ACT}`)).toHaveLength(0);
    const listRows = await partition(`LIST#${listId}`);
    expect(listRows.filter((row) => String(row.sk).startsWith('LNK#'))).toHaveLength(0);
  };

  it.each([
    ['activityId', { activityId: undefined }],
    ['creationTarget', { creationTarget: undefined }],
    ['audience', { audience: undefined }],
    ['a type on the Plan target', { creationTarget: { objectKind: 'plan' } }],
    [
      'matching details',
      {
        creationTarget: { objectKind: 'plan', type: 'watch' },
        details: { kind: 'meal' },
      },
    ],
  ])('400s a request with no %s and writes nothing', async (_why, overrides) => {
    const { list, item } = await setUp();
    const body = validBody(overrides);
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete body[key];
    }

    const res = await schedule(list.listId, item.itemId, body);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    await noPlanWritten(list.listId);
  });

  it('400s a reminder that carries no reminderId', async () => {
    const { list, item } = await setUp();

    const res = await schedule(
      list.listId,
      item.itemId,
      validBody({
        schedule: { date: '2026-09-01', time: '19:30', timezone: 'America/New_York' },
        reminders: [{ offsetMinutes: -30 }],
      }),
    );

    expect(res.status).toBe(400);
    await noPlanWritten(list.listId);
  });

  it('400s selected_people with the shared copy', async () => {
    const { list, item } = await setUp();

    const res = await schedule(
      list.listId,
      item.itemId,
      validBody({
        audience: { mode: 'selected_people', participants: [{ displayName: 'Sam' }] },
      }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Sharing is coming soon.');
    await noPlanWritten(list.listId);
  });

  /** Temporary, removed by P3-22. Writing the Plan and dropping them would be worse. */
  it('400s a non-empty attachmentIds', async () => {
    const { list, item } = await setUp();

    const res = await schedule(
      list.listId,
      item.itemId,
      validBody({ attachmentIds: ['att_01J8XKQ2M4N5P6R7S8T9V0W1X6'] }),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe('Attachments are coming soon.');
    await noPlanWritten(list.listId);
  });

  it('404s an item that does not exist', async () => {
    const list = await createList();

    const res = await schedule(
      list.listId,
      'itm_01J8XKQ2M4N5P6R7S8T9V0W1X9',
      validBody(),
    );

    expect(res.status).toBe(404);
    await noPlanWritten(list.listId);
  });

  it('404s a list the caller has no pointer to', async () => {
    const { list, item } = await setUp();

    const res = await schedule(list.listId, item.itemId, validBody(), {}, asBen());

    expect(res.status).toBe(404);
    await noPlanWritten(list.listId);
  });
});

describe('reminders travel under the ids the device already armed', () => {
  const timed = {
    schedule: { date: '2026-09-01', time: '19:30', timezone: 'America/New_York' },
    reminders: [
      { reminderId: REM_A, offsetMinutes: -30 },
      { reminderId: REM_B, offsetMinutes: -1440 },
    ],
  };

  it('writes exactly two caller rows under those ids', async () => {
    const { list, item } = await setUp();

    expect((await schedule(list.listId, item.itemId, validBody(timed))).status).toBe(201);

    const reminders = (await partition(`ACT#${ACT}`)).filter((row) =>
      String(row.sk).startsWith('REM#'),
    );
    expect(reminders).toHaveLength(2);
    expect(reminders.map((row) => row.reminderId).sort()).toEqual([REM_A, REM_B].sort());
    expect(reminders.every((row) => row.userId === DEV)).toBe(true);
  });

  it('creates no third row when the same action replays', async () => {
    const { list, item } = await setUp();
    await schedule(list.listId, item.itemId, validBody(timed));

    await schedule(list.listId, item.itemId, validBody(timed));

    expect(
      (await partition(`ACT#${ACT}`)).filter((row) => String(row.sk).startsWith('REM#')),
    ).toHaveLength(2);
  });
});

describe('replay, and the pointer it must not roll back', () => {
  it('creates one Plan when the same idempotency key repeats', async () => {
    const { list, item } = await setUp();
    const key = crypto.randomUUID();

    const first = await schedule(list.listId, item.itemId, validBody(), {
      'Idempotency-Key': key,
    });
    const second = await schedule(list.listId, item.itemId, validBody(), {
      'Idempotency-Key': key,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(
      (await partition(`ACT#${ACT}`)).filter((row) => row.sk === 'META'),
    ).toHaveLength(1);
  });

  /**
   * A fresh key replaying the same `activityId` is the receipt-expired case: the Activity
   * already exists, so it is adopted rather than created a second time.
   */
  it('creates one Plan when the activityId replays under a fresh key', async () => {
    const { list, item } = await setUp();
    await schedule(list.listId, item.itemId, validBody());

    const replay = await schedule(list.listId, item.itemId, validBody());

    expect(replay.status).toBe(201);
    expect((await replay.json()).data.activity.activityId).toBe(ACT);
    expect(
      (await partition(`ACT#${ACT}`)).filter((row) => row.sk === 'META'),
    ).toHaveLength(1);
  });

  /**
   * The case §P3-13 calls out by name. A newer confirmed action replaced the pointer; the
   * older id replaying afterwards must return that newer pointer and leave it standing.
   */
  it('does not roll the pointer back to the older Plan', async () => {
    const { list, item } = await setUp();
    await schedule(list.listId, item.itemId, validBody());

    const newer = await schedule(
      list.listId,
      item.itemId,
      validBody({ activityId: ACT_TWO }),
    );
    expect(newer.status).toBe(201);

    const replay = await schedule(list.listId, item.itemId, validBody());

    expect((await replay.json()).data.viewerLink.activityId).toBe(ACT_TWO);
    const link = await rawItem(`LIST#${list.listId}`, `LNK#${DEV}#${item.itemId}`);
    expect(link?.activityId).toBe(ACT_TWO);
  });

  it('replaces only the caller’s pointer when a fresh action is confirmed', async () => {
    const { list, item } = await setUp();
    await schedule(list.listId, item.itemId, validBody());

    await schedule(list.listId, item.itemId, validBody({ activityId: ACT_TWO }));

    const links = (await partition(`LIST#${list.listId}`)).filter((row) =>
      String(row.sk).startsWith('LNK#'),
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.activityId).toBe(ACT_TWO);
    /** The older Plan survives as an ordinary Plan; nothing deletes it. */
    expect(
      (await partition(`ACT#${ACT}`)).filter((row) => row.sk === 'META'),
    ).toHaveLength(1);
  });

  it('409s an activityId that belongs to something else', async () => {
    const first = await setUp();
    await schedule(first.list.listId, first.item.itemId, validBody());

    const second = await setUp();
    const res = await schedule(second.list.listId, second.item.itemId, validBody());

    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(
      'That id is already in use. Try again.',
    );
  });
});
