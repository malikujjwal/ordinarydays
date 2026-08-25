import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { List, ListItem } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { documents, TEST_TABLE, useTestTable } from './harness.js';

useTestTable();

/**
 * `POST /v1/activities/:id/ingredients/add-to-list` through the real app, against DynamoDB
 * Local (§P3-17's test list).
 *
 * The things only a real table settles, and the reasons they are here rather than in a unit
 * test with a mocked repository:
 *
 * - **Nothing is written before the tap** (acceptance criterion 13). A meal with four
 *   ingredients has to leave the destination list genuinely empty, which is a claim about
 *   every row in that partition — not about which repository method a mock saw.
 * - **The label survives its source.** Rescheduling and then deleting the meal must leave
 *   the stored `sourceLabel` byte-identical (criterion 15), and "stored" is the whole point.
 * - **Selection is by id, not position.** Reordering the meal's ingredients between the
 *   request being composed and replayed is a real mutation of a real `details.ingredients`
 *   array, and the per-index write condition either holds against it or does not.
 * - **Replay adds nothing twice**, under the same key and after the receipt is gone.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

const DEV = 'usr_local_dev';

const MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OTHER_MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const CHICKEN = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const TORTILLAS = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';
const TOMATOES = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3';
const SOUR_CREAM = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A4';

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
});

const app = () => createApp();

type Json = Record<string, unknown>;

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

const itemRows = async (listId: string) =>
  (await partition(`LIST#${listId}`)).filter((row) => String(row.sk).startsWith('ITEM#'));

const storedMeal = async (activityId = MEAL) =>
  (await rawItem(`ACT#${activityId}`, 'META')) as Json | undefined;

const storedIngredients = async (activityId = MEAL) => {
  const meal = await storedMeal(activityId);
  const details = meal?.details as { ingredients?: Json[] } | undefined;
  return details?.ingredients ?? [];
};

/** The four rows of §9.2's worked example, `Sour cream` deliberately last and unselected. */
const INGREDIENTS = [
  { ingredientId: CHICKEN, name: 'Chicken' },
  { ingredientId: TORTILLAS, name: 'Tortillas', quantity: '8' },
  { ingredientId: TOMATOES, name: 'Tomatoes' },
  { ingredientId: SOUR_CREAM, name: 'Sour cream' },
];

/** A Sunday, so §7.5 rule 1 produces the doc's own `Sunday dinner`. */
const SUNDAY = nextSunday();

function nextSunday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + ((7 - date.getUTCDay()) % 7 || 7));
  return date.toISOString().slice(0, 10);
}

const createMeal = async (overrides: Json = {}, activityId = MEAL) => {
  const res = await request('POST', '/v1/activities', {
    activityId,
    objectKind: 'plan',
    type: 'meal',
    title: 'Chicken tacos',
    details: { kind: 'meal', mealSlot: 'dinner', ingredients: INGREDIENTS },
    schedule: { date: SUNDAY, time: '19:00', timezone: 'America/New_York' },
    ...overrides,
  });
  expect(res.status).toBe(201);
  return (await res.json()).data as Json;
};

const createList = async (title = 'Groceries', templateKey = 'groceries') => {
  const res = await request('POST', '/v1/lists', { title, templateKey });
  expect(res.status).toBe(201);
  return (await res.json()).data as List;
};

const addItem = async (listId: string, title: string, checked?: boolean) => {
  const res = await request('POST', `/v1/lists/${listId}/items`, { title });
  expect(res.status).toBe(201);
  const item = (await res.json()).data as ListItem;
  if (checked === true) {
    const patched = await request('PATCH', `/v1/lists/${listId}/items/${item.itemId}`, {
      checked: true,
    });
    expect(patched.status).toBe(200);
  }
  return item;
};

const addToList = (
  listId: string,
  ingredientIds: readonly string[],
  headers: Record<string, string> = {},
  activityId = MEAL,
) =>
  request(
    'POST',
    `/v1/activities/${activityId}/ingredients/add-to-list`,
    {
      listId,
      ingredients: ingredientIds.map((ingredientId) => ({ ingredientId })),
    },
    headers,
  );

const setUp = async () => {
  await createMeal();
  const list = await createList();
  return { list };
};

describe('nothing happens until the user asks for it', () => {
  /** Acceptance criterion 13, first sentence, and the risk row on automatic adds. */
  it('creates a meal with four ingredients and leaves the destination list empty', async () => {
    const { list } = await setUp();

    expect(await itemRows(list.listId)).toHaveLength(0);
    const meta = (await rawItem(`LIST#${list.listId}`, 'META')) as Json;
    expect(meta.itemCount).toBe(0);
  });

  it('records no addedToListId on any ingredient before the action runs', async () => {
    await setUp();

    for (const ingredient of await storedIngredients()) {
      expect(ingredient).not.toHaveProperty('addedToListId');
    }
  });
});

describe('the confirmed action', () => {
  it('writes exactly the three selected rows, labelled and attributed', async () => {
    const { list } = await setUp();

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    expect(res.status).toBe(201);
    const body = (await res.json()).data as Json;
    expect(body.sourceLabel).toBe('Sunday dinner');

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.title).sort()).toEqual([
      'Chicken',
      'Tomatoes',
      'Tortillas (8)',
    ]);
    for (const row of rows) {
      expect(row.sourceActivityId).toBe(MEAL);
      expect(row.sourceLabel).toBe('Sunday dinner');
    }
  });

  it('leaves the unselected ingredient off the list and unmarked', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    const rows = await itemRows(list.listId);
    expect(rows.map((row) => row.title)).not.toContain('Sour cream');

    const ingredients = await storedIngredients();
    const sourCream = ingredients.find((row) => row.ingredientId === SOUR_CREAM);
    expect(sourCream).not.toHaveProperty('addedToListId');
  });

  it('marks each selected source ingredient as added, and only those', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    const byId = new Map(
      (await storedIngredients()).map((row) => [row.ingredientId, row.addedToListId]),
    );
    expect(byId.get(CHICKEN)).toBe(list.listId);
    expect(byId.get(TORTILLAS)).toBe(list.listId);
    expect(byId.get(TOMATOES)).toBe(list.listId);
    expect(byId.get(SOUR_CREAM)).toBeUndefined();
  });

  /**
   * The `updatedAt` decision, asserted rather than only documented: this write is bookkeeping
   * about a different object, so it must not read as an edit to the meal.
   */
  it('does not advance the meal’s updatedAt', async () => {
    const { list } = await setUp();
    const before = await storedMeal();

    await addToList(list.listId, [CHICKEN]);

    const after = await storedMeal();
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.lastActivityAt).toBe(before?.lastActivityAt);
  });

  it('reports what happened to each ingredient, in the order they were sent', async () => {
    const { list } = await setUp();

    const res = await addToList(list.listId, [TOMATOES, CHICKEN]);

    const body = (await res.json()).data as { ingredients: Json[] };
    expect(body.ingredients.map((row) => row.ingredientId)).toEqual([TOMATOES, CHICKEN]);
    expect(body.ingredients.map((row) => row.outcome)).toEqual(['created', 'created']);
    expect(body.ingredients[0]?.item).not.toHaveProperty('itemRevision');
  });
});

describe('the duplicate rule, in all three states', () => {
  it('absent: creates a new row', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN]);

    const rows = await itemRows(list.listId);
    expect(rows.filter((row) => row.title === 'Chicken')).toHaveLength(1);
  });

  /** Acceptance criterion 14, first half. */
  it('present and unchecked: extends the label and creates nothing', async () => {
    const { list } = await setUp();
    const existing = await addItem(list.listId, 'chicken');
    await request('PATCH', `/v1/lists/${list.listId}/items/${existing.itemId}`, {});

    const res = await addToList(list.listId, [CHICKEN]);

    expect(res.status).toBe(201);
    const body = (await res.json()).data as { ingredients: Json[] };
    expect(body.ingredients[0]?.outcome).toBe('labelled');

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(1);
    // The match is case-insensitive, and it is the **existing** row that survives — the
    // user's own capitalisation is not overwritten by the ingredient's.
    expect(rows[0]?.title).toBe('chicken');
    expect(rows[0]?.sourceLabel).toBe('Sunday dinner');
  });

  it('extends an existing label rather than replacing it', async () => {
    const { list } = await setUp();
    await createMeal(
      {
        title: 'Chicken soup',
        details: {
          kind: 'meal',
          mealSlot: 'lunch',
          ingredients: [{ ingredientId: CHICKEN, name: 'Chicken' }],
        },
        schedule: { date: SUNDAY, time: '12:00', timezone: 'America/New_York' },
      },
      OTHER_MEAL,
    );

    await addToList(list.listId, [CHICKEN], {}, OTHER_MEAL);
    await addToList(list.listId, [CHICKEN]);

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceLabel).toBe('Sunday lunch · Sunday dinner');
  });

  /** Acceptance criterion 14, second half: it was already bought. */
  it('present and checked: creates a second row', async () => {
    const { list } = await setUp();
    await addItem(list.listId, 'Chicken', true);

    const res = await addToList(list.listId, [CHICKEN]);

    const body = (await res.json()).data as { ingredients: Json[] };
    expect(body.ingredients[0]?.outcome).toBe('created');

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.checked === false)).toHaveLength(1);
  });
});

describe('rule 5: two meals that produced the same words', () => {
  it('appends the meal title when another meal already used the label', async () => {
    const { list } = await setUp();
    await createMeal(
      {
        title: 'Roast dinner',
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [{ ingredientId: TOMATOES, name: 'Potatoes' }],
        },
      },
      OTHER_MEAL,
    );

    await addToList(list.listId, [TOMATOES], {}, OTHER_MEAL);
    const res = await addToList(list.listId, [CHICKEN]);

    const body = (await res.json()).data as Json;
    expect(body.sourceLabel).toBe('Sunday dinner · Chicken tacos');
  });

  it('does not disambiguate a meal from itself', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN]);
    const res = await addToList(list.listId, [TOMATOES]);

    expect(((await res.json()).data as Json).sourceLabel).toBe('Sunday dinner');
  });
});

describe('the label is computed once and stored', () => {
  /** Acceptance criterion 15, and the risk row on recomputed labels. */
  it('is unchanged after the source meal is rescheduled', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN]);
    const before = (await itemRows(list.listId))[0];

    const meal = await storedMeal();
    const res = await request(
      'POST',
      `/v1/activities/${MEAL}/schedule`,
      { date: '2027-03-15', time: '19:00', timezone: 'America/New_York' },
      { 'If-Match': String(meal?.updatedAt) },
    );
    expect(res.status).toBe(200);

    expect((await itemRows(list.listId))[0]).toEqual(before);
  });

  it('is unchanged after the source meal is deleted, and the item survives', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN]);
    const before = (await itemRows(list.listId))[0];

    const res = await request('DELETE', `/v1/activities/${MEAL}`);
    expect(res.status).toBe(200);

    const after = (await itemRows(list.listId))[0];
    expect(after).toEqual(before);
    expect(after?.sourceLabel).toBe('Sunday dinner');
    // The back-link is retained and simply stops resolving — §6.5's non-navigable back-link.
    expect(after?.sourceActivityId).toBe(MEAL);
  });
});

describe('selection is by id, never by position', () => {
  /**
   * The offline case §P3-17 names: the request was composed against one order and arrives
   * after another. The ids it carries still name the rows the user ticked.
   */
  it('adds the originally selected ids after the ingredients are reordered', async () => {
    const { list } = await setUp();
    const meal = await storedMeal();

    const reordered = await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      {
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [...INGREDIENTS].reverse(),
        },
      },
      { 'If-Match': String(meal?.updatedAt) },
    );
    expect(reordered.status).toBe(200);

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS]);

    expect(res.status).toBe(201);
    expect((await itemRows(list.listId)).map((row) => row.title).sort()).toEqual([
      'Chicken',
      'Tortillas (8)',
    ]);

    // And the flags landed on those same two rows, wherever they now sit.
    const byId = new Map(
      (await storedIngredients()).map((row) => [row.ingredientId, row.addedToListId]),
    );
    expect(byId.get(CHICKEN)).toBe(list.listId);
    expect(byId.get(TORTILLAS)).toBe(list.listId);
    expect(byId.get(TOMATOES)).toBeUndefined();
  });

  it('rejects the whole action when one selected row has been deleted', async () => {
    const { list } = await setUp();
    const meal = await storedMeal();

    await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      {
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: INGREDIENTS.filter((row) => row.ingredientId !== TORTILLAS),
        },
      },
      { 'If-Match': String(meal?.updatedAt) },
    );

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS]);

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(await itemRows(list.listId)).toHaveLength(0);
    for (const ingredient of await storedIngredients()) {
      expect(ingredient).not.toHaveProperty('addedToListId');
    }
  });
});

describe('replay adds nothing twice', () => {
  it('returns the stored response under the same idempotency key', async () => {
    const { list } = await setUp();
    const key = crypto.randomUUID();

    const first = await addToList(list.listId, [CHICKEN, TOMATOES], {
      'Idempotency-Key': key,
    });
    const second = await addToList(list.listId, [CHICKEN, TOMATOES], {
      'Idempotency-Key': key,
    });

    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    expect(await itemRows(list.listId)).toHaveLength(2);
  });

  /**
   * After the receipt expires the request runs again for real, and replay protection falls to
   * the stable `itm_` ids the client minted — the same trade `createItemsBulk` documents.
   */
  it('creates no duplicate under a new key when the client minted item ids', async () => {
    const { list } = await setUp();
    const body = {
      listId: list.listId,
      ingredients: [
        { ingredientId: CHICKEN, itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B1' },
        { ingredientId: TOMATOES, itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1B2' },
      ],
    };
    const path = `/v1/activities/${MEAL}/ingredients/add-to-list`;

    expect((await request('POST', path, body)).status).toBe(201);
    const replay = await request('POST', path, body);

    // The second attempt finds both rows unchecked and already carrying this label, so it
    // extends nothing and creates nothing — §7.3's duplicate rule absorbing the retry.
    expect(replay.status).toBe(201);
    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceLabel)).toEqual([
      'Sunday dinner',
      'Sunday dinner',
    ]);
  });
});

describe('what it refuses, and writes nothing for', () => {
  it('400s a non-meal activity', async () => {
    const list = await createList();
    const res = await request('POST', '/v1/activities', {
      activityId: MEAL,
      objectKind: 'plan',
      type: 'event',
      title: 'Dinner party',
      details: { kind: 'event' },
    });
    expect(res.status).toBe(201);

    const added = await addToList(list.listId, [CHICKEN]);

    expect(added.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  it.each([
    ['watch', 'watchlist'],
    ['meals', 'meals-to-try'],
  ])('400s a %s list, which has no room for a bare title', async (_why, templateKey) => {
    await createMeal();
    const list = await createList('Elsewhere', templateKey);

    const res = await addToList(list.listId, [CHICKEN]);

    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  it('404s a list the caller cannot see', async () => {
    await createMeal();

    const res = await addToList('lst_01J8XKQ2M4N5P6R7S8T9V0W1C9', [CHICKEN]);

    expect(res.status).toBe(404);
  });

  it('400s an ingredient id the meal never had, and writes nothing', async () => {
    const { list } = await setUp();

    const res = await addToList(list.listId, ['ing_01J8XKQ2M4N5P6R7S8T9V0W1C8']);

    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  it('400s a request with no Idempotency-Key', async () => {
    const { list } = await setUp();

    const res = await app().fetch(
      new Request(`http://localhost/v1/activities/${MEAL}/ingredients/add-to-list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          listId: list.listId,
          ingredients: [{ ingredientId: CHICKEN }],
        }),
      }),
    );

    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  /**
   * The contract test §P3-17 asks for: provenance is derivable only from the meal, so the
   * ordinary bulk route must keep refusing it outright rather than dropping it silently.
   */
  it.each(['sourceActivityId', 'sourceLabel'])(
    '400s %s on the ordinary bulk route',
    async (field) => {
      const list = await createList();

      const res = await request('POST', `/v1/lists/${list.listId}/items/bulk`, {
        items: [
          {
            title: 'Chicken',
            [field]: field === 'sourceLabel' ? 'Sunday dinner' : MEAL,
          },
        ],
      });

      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('validation_failed');
      expect(await itemRows(list.listId)).toHaveLength(0);
    },
  );

  it('400s provenance on the ordinary single-item route too', async () => {
    const list = await createList();

    const res = await request('POST', `/v1/lists/${list.listId}/items`, {
      title: 'Chicken',
      sourceLabel: 'Sunday dinner',
    });

    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });
});

describe('the destination the user confirmed', () => {
  /**
   * §P3-17's `defaultLists` line. Resolution is the client's, so this endpoint must take the
   * explicit `listId` and leave the stored default entirely alone — writing one here would
   * make an override for this operation permanent.
   */
  it('writes the items to the explicit listId and leaves defaultLists untouched', async () => {
    await createMeal();
    const groceries = await createList('Groceries');
    const other = await createList('Corner shop');

    const before = (await rawItem(`USER#${DEV}`, 'PROFILE')) as Json | undefined;
    const res = await addToList(other.listId, [CHICKEN]);

    expect(res.status).toBe(201);
    expect(await itemRows(other.listId)).toHaveLength(1);
    expect(await itemRows(groceries.listId)).toHaveLength(0);

    const after = (await rawItem(`USER#${DEV}`, 'PROFILE')) as Json | undefined;
    expect(after?.defaultLists).toEqual(before?.defaultLists);
  });

  it('creates no second Activity, whatever the action did', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    const userRows = await partition(`USER#${DEV}`);
    expect(userRows.filter((row) => String(row.sk).startsWith('IDX#'))).toHaveLength(1);
  });
});
