import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Activity, List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * P3-44: the rest of `activities.md` §5.3 on the completion response, against DynamoDB Local.
 *
 * Every row is data; completing never writes anywhere but the Activity. The prep-task row
 * wins over the type's own row, counts only incomplete non-recurring children, and a
 * recurring occurrence never carries a follow-up at all.
 */

type AppModule = typeof import('../../src/app.js');
type Json = Record<string, unknown>;

let createApp: AppModule['createApp'];

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
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

const createList = async (title: string, templateKey: string) => {
  const response = await request('POST', '/v1/lists', { title, templateKey });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).data as List;
};

const addItem = async (listId: string, title: string, features?: Json) => {
  const response = await request('POST', `/v1/lists/${listId}/items`, {
    title,
    ...(features === undefined ? {} : { features }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).data as ListItem;
};

const planItem = async (
  listId: string,
  itemId: string,
  type: 'event' | 'meal' | 'watch',
  details: Json,
  activityId = ACT,
) => {
  const response = await request('POST', `/v1/lists/${listId}/items/${itemId}/schedule`, {
    activityId,
    creationTarget: { objectKind: 'plan', type },
    audience: { mode: 'just_me' },
    details,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).data as Activity;
};

const createActivity = async (body: Json) => {
  const response = await request('POST', '/v1/activities', body);
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()).data as Activity;
};

const complete = async (activityId: string, body: Json = {}) => {
  const response = await request('POST', `/v1/activities/${activityId}/complete`, body);
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

describe('an Event bridged from a checkbox List with Place', () => {
  it('offers Mark visited by item title and leaves the List partition untouched', async () => {
    const list = await createList('Places', 'places-to-visit');
    const item = await addItem(list.listId, 'Louvre');
    await planItem(list.listId, item.itemId, 'event', { kind: 'event' });
    const before = await listPartition(list.listId);

    const data = await complete(ACT);

    expect(data.followUp).toEqual({
      kind: 'list_item_state',
      listId: list.listId,
      listTitle: 'Places',
      itemId: item.itemId,
      itemTitle: 'Louvre',
      current: { state: 'open' },
      target: { state: 'done' },
    });
    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('offers nothing from a List without Place, or for an Event typed by hand', async () => {
    const list = await createList('Errands', 'checklist');
    const item = await addItem(list.listId, 'Post office');
    await planItem(list.listId, item.itemId, 'event', { kind: 'event' });
    expect((await complete(ACT)).followUp).toBeUndefined();

    const typed = await createActivity({
      objectKind: 'plan',
      type: 'event',
      title: 'Dentist',
      details: { kind: 'event' },
    });
    expect((await complete(typed.activityId)).followUp).toBeUndefined();
  });
});

describe('a Meal from a List with the mealIngredients integration', () => {
  it('offers the ingredient picker with the count still to add', async () => {
    const list = await createList('Meal ideas', 'meal-ideas');
    const item = await addItem(list.listId, 'Chicken curry');
    await planItem(list.listId, item.itemId, 'meal', {
      kind: 'meal',
      ingredients: [
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2', name: 'Chicken' },
        { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X3', name: 'Rice' },
      ],
    });
    const before = await listPartition(list.listId);

    expect((await complete(ACT)).followUp).toEqual({
      kind: 'meal_ingredients',
      remaining: 2,
    });
    expect(await listPartition(list.listId)).toEqual(before);
  });

  it('offers nothing for a Meal typed by hand, whatever its ingredients say', async () => {
    const typed = await createActivity({
      objectKind: 'plan',
      type: 'meal',
      title: 'Chicken curry',
      details: {
        kind: 'meal',
        ingredients: [
          { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1X2', name: 'Chicken' },
        ],
      },
    });
    expect((await complete(typed.activityId)).followUp).toBeUndefined();
  });
});

describe('open prep tasks', () => {
  const planWithChildren = async (recurringChild: boolean) => {
    const plan = await createActivity({
      objectKind: 'plan',
      type: 'custom',
      title: 'Trip',
    });
    const open = await createActivity({
      objectKind: 'task',
      type: 'task',
      title: 'Book hotel',
      parentActivityId: plan.activityId,
    });
    const done = await createActivity({
      objectKind: 'task',
      type: 'task',
      title: 'Buy tickets',
      parentActivityId: plan.activityId,
    });
    await complete(done.activityId);
    const recurring = recurringChild
      ? await createActivity({
          objectKind: 'task',
          type: 'task',
          title: 'Water plants',
          parentActivityId: plan.activityId,
          schedule: { date: '2026-09-01', timezone: 'UTC' },
          recurrence: {
            mode: 'fixed',
            segments: [{ freq: 'daily', effectiveFrom: '2026-09-01' }],
          },
        })
      : undefined;
    return { plan, open, done, recurring };
  };

  it('counts only incomplete non-recurring children and names exactly those', async () => {
    const { plan, open } = await planWithChildren(true);

    expect((await complete(plan.activityId)).followUp).toEqual({
      kind: 'open_prep',
      count: 1,
      childIds: [open.activityId],
    });
  });

  it('wins over the type row when both apply', async () => {
    const list = await createList('Places', 'places-to-visit');
    const item = await addItem(list.listId, 'Louvre');
    await planItem(list.listId, item.itemId, 'event', { kind: 'event' });
    const child = await createActivity({
      objectKind: 'task',
      type: 'task',
      title: 'Buy tickets',
      parentActivityId: ACT,
    });

    expect((await complete(ACT)).followUp).toEqual({
      kind: 'open_prep',
      count: 1,
      childIds: [child.activityId],
    });
  });

  it('leaves the children untouched: completing the plan never completes them', async () => {
    const { plan, open } = await planWithChildren(false);
    await complete(plan.activityId);

    const response = await request('GET', `/v1/activities/${open.activityId}`);
    expect(((await response.json()).data as Activity).status).not.toBe('completed');
  });
});

describe('a recurring occurrence', () => {
  it('never carries a follow-up, even with open one-off prep tasks', async () => {
    const series = await createActivity({
      objectKind: 'plan',
      type: 'custom',
      title: 'Weekly review',
      schedule: { date: '2026-09-01', timezone: 'UTC' },
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-09-01' }],
      },
    });
    await createActivity({
      objectKind: 'task',
      type: 'task',
      title: 'Collect notes',
      parentActivityId: series.activityId,
    });

    const data = await complete(series.activityId, { occurrenceDate: '2026-09-01' });

    expect(data.followUp).toBeUndefined();
  });
});
