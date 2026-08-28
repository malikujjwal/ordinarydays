import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * The P3-33 Watch follow-up against DynamoDB Local.
 *
 * Completion may describe one independent List edit, but completion itself must leave the
 * entire List partition byte-identical. Structured episode Progress wins when it can ask a
 * non-empty question; exposed intrinsic state is the fallback. Confirming is the ordinary
 * item PATCH, never a hidden completion-side write.
 */

type AppModule = typeof import('../../src/app.js');
type Json = Record<string, unknown>;

let createApp: AppModule['createApp'];

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ACT_TWO = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const LIST_TITLE = 'Movies and shows';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
});

const app = () => createApp();

const request = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  app().fetch(
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

const createList = async () => {
  const response = await request('POST', '/v1/lists', {
    title: LIST_TITLE,
    templateKey: 'watch-later',
  });
  expect(response.status).toBe(201);
  return (await response.json()).data as List;
};

const addItem = async (listId: string, features?: Json) => {
  const response = await request('POST', `/v1/lists/${listId}/items`, {
    title: 'Severance',
    ...(features === undefined ? {} : { features }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).data as ListItem;
};

const planItem = async (
  listId: string,
  itemId: string,
  details: Json,
  activityId = ACT,
  extra: Json = {},
) => {
  const response = await request('POST', `/v1/lists/${listId}/items/${itemId}/schedule`, {
    activityId,
    creationTarget: { objectKind: 'plan', type: 'watch' },
    audience: { mode: 'just_me' },
    details,
    ...extra,
  });
  expect(response.status).toBe(201);
};

const complete = async (activityId = ACT, body: Json = {}) => {
  const response = await request('POST', `/v1/activities/${activityId}/complete`, body);
  expect(response.status).toBe(200);
  return (await response.json()).data as Json;
};

const storedItem = async (listId: string, itemId: string) => {
  const response = await request('GET', `/v1/lists/${listId}/items/${itemId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()).data as Json;
};

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

const activityCount = async () => {
  const result = await documents.send(
    new ScanCommand({ TableName: TEST_TABLE, ConsistentRead: true }),
  );
  return (result.Items ?? []).filter((row) => row.entity === 'Activity').length;
};

const episode = (overrides: Json = {}) => ({
  progress: {
    kind: 'episode',
    mediaKind: 'show',
    season: 2,
    episode: 4,
    ...overrides,
  },
});

describe('structured episode Progress', () => {
  const setUp = async (session: Json = {}) => {
    const list = await createList();
    const item = await addItem(list.listId, episode());
    await planItem(list.listId, item.itemId, {
      kind: 'watch',
      mediaTitle: 'Severance',
      mediaKind: 'show',
      season: 2,
      episode: 5,
      ...session,
    });
    return { list, item };
  };

  it('offers S2 E5 while leaving the complete List partition untouched', async () => {
    const { list, item } = await setUp();
    const before = await listPartition(list.listId);

    const data = await complete();

    expect(data.followUp).toEqual({
      kind: 'watch_progress',
      listId: list.listId,
      listTitle: LIST_TITLE,
      itemId: item.itemId,
      mediaKind: 'show',
      current: { season: 2, episode: 4 },
      target: { season: 2, episode: 5 },
    });
    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('changes Progress and open to active only through the confirming item PATCH', async () => {
    const { list, item } = await setUp();
    const data = await complete();
    const followUp = data.followUp as Json;

    const response = await request(
      'PATCH',
      `/v1/lists/${followUp.listId}/items/${followUp.itemId}`,
      {
        state: 'active',
        features: {
          progress: {
            kind: 'episode',
            mediaKind: followUp.mediaKind,
            ...(followUp.target as Json),
          },
        },
      },
    );

    expect(response.status).toBe(200);
    expect(await storedItem(list.listId, item.itemId)).toMatchObject({
      state: 'active',
      features: {
        progress: {
          kind: 'episode',
          mediaKind: 'show',
          season: 2,
          episode: 5,
        },
      },
    });
    expect(await activityCount()).toBe(1);
  });

  it('still asks for a rewatch rather than suppressing an equal target', async () => {
    await setUp({ episode: 4 });

    expect((await complete()).followUp).toMatchObject({
      current: { season: 2, episode: 4 },
      target: { season: 2, episode: 4 },
    });
  });
});

describe('the exposed-state fallback', () => {
  const setUp = async () => {
    const list = await createList();
    const item = await addItem(list.listId);
    await planItem(list.listId, item.itemId, {
      kind: 'watch',
      mediaTitle: 'Severance',
      mediaKind: 'movie',
    });
    return { list, item };
  };

  it('offers done and does not write it during completion', async () => {
    const { list, item } = await setUp();
    const before = await listPartition(list.listId);

    const data = await complete();

    expect(data.followUp).toEqual({
      kind: 'list_item_state',
      listId: list.listId,
      listTitle: LIST_TITLE,
      itemId: item.itemId,
      current: { state: 'open' },
      target: { state: 'done' },
    });
    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('reaches done only through the confirming item PATCH', async () => {
    const { list, item } = await setUp();
    const data = await complete();
    const followUp = data.followUp as Json;

    const response = await request(
      'PATCH',
      `/v1/lists/${followUp.listId}/items/${followUp.itemId}`,
      { state: (followUp.target as Json).state },
    );

    expect(response.status).toBe(200);
    expect(await storedItem(list.listId, item.itemId)).toMatchObject({ state: 'done' });
  });

  it('offers nothing after state presentation is hidden', async () => {
    const { list } = await setUp();
    const response = await request(
      'PATCH',
      `/v1/lists/${list.listId}`,
      { itemStateMode: { mode: 'none' } },
      { 'If-Match': list.updatedAt, 'Idempotency-Key': crypto.randomUUID() },
    );
    expect(response.status).toBe(200);

    expect((await complete()).followUp).toBeUndefined();
  });
});

describe('follow-up eligibility', () => {
  it('a recurring occurrence leaves series and List bytes unchanged and offers nothing', async () => {
    const list = await createList();
    const item = await addItem(list.listId, episode());
    await planItem(
      list.listId,
      item.itemId,
      { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 5 },
      ACT,
      {
        schedule: { date: '2026-08-01', time: '20:00', timezone: 'UTC' },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      },
    );
    const meta = await activityMeta(ACT);
    const before = await listPartition(list.listId);

    const data = await complete(ACT, { occurrenceDate: '2026-08-08' });

    expect(data.followUp).toBeUndefined();
    expect(data.occurrence).toMatchObject({ date: '2026-08-08', status: 'completed' });
    expect(await activityMeta(ACT)).toEqual(meta);
    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('a superseded viewer link silences the old session', async () => {
    const list = await createList();
    const item = await addItem(list.listId, episode());
    await planItem(list.listId, item.itemId, {
      kind: 'watch',
      mediaTitle: 'Severance',
      season: 2,
      episode: 5,
    });
    await planItem(
      list.listId,
      item.itemId,
      { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 6 },
      ACT_TWO,
    );

    expect((await complete(ACT)).followUp).toBeUndefined();
    expect((await complete(ACT_TWO)).followUp).toMatchObject({
      kind: 'watch_progress',
      target: { season: 2, episode: 6 },
    });
  });

  it('a negative outcome removes the pointer and offers nothing', async () => {
    const list = await createList();
    const item = await addItem(list.listId, episode());
    await planItem(list.listId, item.itemId, {
      kind: 'watch',
      mediaTitle: 'Severance',
      season: 2,
      episode: 5,
    });

    const data = await complete(ACT, { outcome: 'didnt_happen' });

    expect(data.activity).toMatchObject({ status: 'skipped' });
    expect(data.followUp).toBeUndefined();
    expect(
      (await listPartition(list.listId)).filter((row) =>
        String(row.sk).startsWith('LNK#'),
      ),
    ).toEqual([]);
  });
});
