import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { fixedClock, MAX_INGREDIENTS_PER_ADD, timeZone } from '@od/shared';
import { type ItemOrigin, itemOriginatesFrom } from '@od/shared/lists';
import { addWallDays } from '@od/shared/recurrence';
import { instant } from '@od/shared/schemas';
import type { List, ListItem } from '@od/shared/types';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
 * - **`Added` is read off the list, never off the meal** (Option B, 2026-09-16). The action
 *   writes no marker and advances no version on the Activity side; it fences the meal it read
 *   with a `ConditionCheck` and records each ingredient's identity on the destination item's
 *   `sourceProvenance`. Whether that claim survives — through a rename, a reorder, an edit,
 *   or a second call from the same meal onto a row it already labelled — is a claim about the
 *   real table, not about which repository method a mock saw.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

const TEST_CLOCK = fixedClock(instant.parse('2026-08-29T16:00:00.000Z'));
let requestTick = 0;

const DEV = 'usr_local_dev';

const MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OTHER_MEAL = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const CHICKEN = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1';
const TORTILLAS = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';
const TOMATOES = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A3';
const SOUR_CREAM = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A4';

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TEST_CLOCK.now());
  createApp = (await import('../../src/app.js')).createApp;
});

beforeEach(() => {
  requestTick = 0;
  vi.setSystemTime(TEST_CLOCK.now());
});

afterAll(() => {
  vi.useRealTimers();
});

const app = () => createApp({ rateLimitNow: () => Date.parse(TEST_CLOCK.now()) });

type Json = Record<string, unknown>;

const request = (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  vi.setSystemTime(Date.parse(TEST_CLOCK.now()) + requestTick * 1_000);
  requestTick += 1;
  return app().fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(method === 'POST' || method === 'DELETE'
          ? { 'Idempotency-Key': crypto.randomUUID() }
          : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
};

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

/**
 * The receipt for **one exact key**, not a prefix count.
 *
 * `setUp` issues its own POSTs, each with its own random key, so any "are there receipts"
 * scan is satisfied by those and says nothing about the request under test. Both callers
 * therefore send a key they chose and ask about that one row.
 */
const receiptFor = async (key: string, userId = DEV) =>
  rawItem(`IDEM#${userId}#${key}`, 'META');

const itemRows = async (listId: string) =>
  (await partition(`LIST#${listId}`)).filter((row) => String(row.sk).startsWith('ITEM#'));

/**
 * The item as a client would actually read it — through `GET`, so `origins` is the response
 * mapper's derivation (`toListItem`) rather than something this suite recomputes from raw
 * `sourceProvenance` (Option B, 2026-09-16).
 */
const getItem = async (listId: string, itemId: string): Promise<Json> => {
  const res = await request('GET', `/v1/lists/${listId}/items/${itemId}`);
  expect(res.status).toBe(200);
  return (await res.json()).data as Json;
};

/** The one predicate for "does this item answer for this meal's ingredient?", against a
 *  `GET` response's loosely-typed JSON rather than the `ListItem` shape it structurally is. */
const originates = (item: Json, activityId: string, ingredientId: string): boolean =>
  itemOriginatesFrom(
    item as unknown as { origins?: ItemOrigin[] },
    activityId,
    ingredientId,
  );

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

/**
 * A Sunday dinner. Before 2026-09-11 §7.5 labelled it `Sunday dinner`; the label is now the
 * plan's name, `Chicken tacos`, and the date is kept so every test proves the day is ignored.
 */
const SUNDAY = nextSunday();

function nextSunday(): string {
  const today = TEST_CLOCK.todayIn(timeZone.parse('America/New_York'));
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addWallDays(today, (7 - weekday) % 7 || 7);
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

const addItem = async (listId: string, title: string, done?: boolean) => {
  const res = await request('POST', `/v1/lists/${listId}/items`, { title });
  expect(res.status).toBe(201);
  const item = (await res.json()).data as ListItem;
  if (done === true) {
    const patched = await request('PATCH', `/v1/lists/${listId}/items/${item.itemId}`, {
      state: 'done',
    });
    expect(patched.status).toBe(200);
  }
  return item;
};

/**
 * Supplied destination item ids are the replay protection that outlives the 24-hour receipt.
 * Derived from the ingredient id so a test replaying the same selection sends the same ids,
 * exactly as an offline client re-sending its queued payload would. The contract also permits
 * omission; that server-minted path is tested separately.
 */
const destinationItemId = (ingredientId: string) =>
  `itm_${ingredientId.slice('ing_'.length)}`;

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
      ingredients: ingredientIds.map((ingredientId) => ({
        ingredientId,
        itemId: destinationItemId(ingredientId),
      })),
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
  it('writes exactly the three selected rows, labelled, attributed and carrying their ingredient origin', async () => {
    const { list } = await setUp();

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    expect(res.status).toBe(201);
    const body = (await res.json()).data as { sourceLabel: string; ingredients: Json[] };
    expect(body.sourceLabel).toBe('Chicken tacos');

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.title).sort()).toEqual([
      'Chicken',
      'Tomatoes',
      'Tortillas (8)',
    ]);
    const ingredientIdByTitle: Record<string, string> = {
      Chicken: CHICKEN,
      Tomatoes: TOMATOES,
      'Tortillas (8)': TORTILLAS,
    };
    for (const row of rows) {
      expect(row.sourceActivityId).toBe(MEAL);
      expect(row.sourceLabel).toBe('Chicken tacos');
      expect(row.sourceProvenance).toEqual([
        {
          activityId: MEAL,
          label: 'Chicken tacos',
          ingredientIds: [ingredientIdByTitle[String(row.title)]],
        },
      ]);
    }

    // The response item already carries the derived origin (Option B, 2026-09-16) — exactly
    // the selected ingredient, and nothing a client would have to re-fetch to learn.
    const originByIngredient = new Map(
      (body.ingredients as { ingredientId: string; item: Json }[]).map((row) => [
        row.ingredientId,
        row.item.origins,
      ]),
    );
    for (const ingredientId of [CHICKEN, TORTILLAS, TOMATOES]) {
      expect(originByIngredient.get(ingredientId)).toEqual([
        { activityId: MEAL, ingredientId },
      ]);
    }

    const chickenLocator = await rawItem(
      `LIST#${list.listId}`,
      `ITEMID#${destinationItemId(CHICKEN)}`,
    );
    expect(chickenLocator).toMatchObject({
      requestedItemId: destinationItemId(CHICKEN),
      itemId: destinationItemId(CHICKEN),
      sourceActivityId: MEAL,
      ingredientId: CHICKEN,
      outcome: 'created',
    });
  });

  it('leaves the unselected ingredient off the list, recorded on no item’s origin', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    const rows = await itemRows(list.listId);
    expect(rows.map((row) => row.title)).not.toContain('Sour cream');
    for (const row of rows) {
      const ids = ((row.sourceProvenance as Json[] | undefined) ?? []).flatMap(
        (segment) => (segment.ingredientIds as string[] | undefined) ?? [],
      );
      expect(ids).not.toContain(SOUR_CREAM);
    }
  });

  /**
   * **Rewritten for Option B (2026-09-16).** `Added` used to be a marker on the meal
   * (`addedToListId`); it is now presence, derived from whether the destination list's own
   * item still originates from this meal's ingredient (`itemOriginatesFrom`,
   * `packages/shared/src/lists/itemOrigin.ts`) — read here exactly as a client would, through
   * `GET`, not by inspecting stored `sourceProvenance` directly.
   */
  it('exposes each selected ingredient’s presence through the shared origin predicate, and only those', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN, TORTILLAS, TOMATOES]);

    const items = await Promise.all(
      (await itemRows(list.listId)).map((row) =>
        getItem(list.listId, String(row.itemId)),
      ),
    );
    const presentFor = (ingredientId: string) =>
      items.some((item) => originates(item, MEAL, ingredientId));

    expect(presentFor(CHICKEN)).toBe(true);
    expect(presentFor(TORTILLAS)).toBe(true);
    expect(presentFor(TOMATOES)).toBe(true);
    expect(presentFor(SOUR_CREAM)).toBe(false);
  });

  /**
   * **Rewritten for Option B (2026-09-16).** The action used to write the meal — bumping
   * `updatedAt` and setting `addedToListId` — because that marker was what made a row read
   * `Added`. Presence now lives entirely on the destination item's `sourceProvenance`
   * (`ingredientMealUnchangedCheck`, `services/api/src/repositories/activityRepository.ts`),
   * so there is nothing left on the Activity side for this action to change: it fences the
   * meal it read with a `ConditionCheck` and writes nothing to it. `activityUpdatedAt` in the
   * response is therefore the version the caller already read, returned so it never has to
   * refetch to learn its own `If-Match` is still good.
   */
  it('does not write the meal — updatedAt is unchanged, and activityUpdatedAt is the read version', async () => {
    const { list } = await setUp();
    const before = await storedMeal();

    const res = await addToList(list.listId, [CHICKEN]);

    const after = await storedMeal();
    expect(after).toEqual(before);
    expect(((await res.json()).data as Json).activityUpdatedAt).toBe(before?.updatedAt);
  });

  /**
   * The mirror of the old "stale If-Match" test, inverted: nothing wrote the meal, so a
   * version read before the add is not stale after it — it is still the current one.
   */
  it('leaves a pre-add If-Match valid, because the add never advances the meal’s version', async () => {
    const { list } = await setUp();
    const before = await storedMeal();

    await addToList(list.listId, [CHICKEN]);

    const stillCurrent = await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      { title: 'Chicken tacos, revised' },
      { 'If-Match': String(before?.updatedAt) },
    );

    expect(stillCurrent.status).toBe(200);
    expect((await storedMeal())?.title).toBe('Chicken tacos, revised');
  });

  /**
   * The extend path's equivalent of the create path's grouping test above: two ingredients of
   * the same meal, sent in the same request, absorbed into the one row their shared title
   * matches — both must be recorded, not only the one classification happened to pick first.
   */
  it('records a second ingredient of the same meal onto a row this meal already labelled', async () => {
    await createMeal({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: [
          { ingredientId: CHICKEN, name: 'Chicken' },
          { ingredientId: TORTILLAS, name: 'chicken' },
        ],
      },
    });
    const list = await createList();

    const first = await addToList(list.listId, [CHICKEN]);
    expect(first.status).toBe(201);
    const second = await addToList(list.listId, [TORTILLAS]);
    expect(second.status).toBe(201);
    const secondBody = (await second.json()).data as { ingredients: Json[] };
    expect(secondBody.ingredients[0]?.outcome).toBe('labelled');

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceProvenance).toEqual([
      { activityId: MEAL, label: 'Chicken tacos', ingredientIds: [CHICKEN, TORTILLAS] },
    ]);

    const item = await getItem(list.listId, String(rows[0]?.itemId));
    expect(originates(item, MEAL, CHICKEN)).toBe(true);
    expect(originates(item, MEAL, TORTILLAS)).toBe(true);
    expect(item.origins).toHaveLength(2);
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
    expect(rows[0]?.sourceLabel).toBe('Chicken tacos');
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
    const extended = await request(
      'POST',
      `/v1/activities/${MEAL}/ingredients/add-to-list`,
      { listId: list.listId, ingredients: [{ ingredientId: CHICKEN }] },
    );
    expect(extended.status).toBe(201);

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceLabel).toBe('Chicken soup · Chicken tacos');
    expect(rows[0]?.sourceProvenance).toEqual([
      { activityId: OTHER_MEAL, label: 'Chicken soup', ingredientIds: [CHICKEN] },
      { activityId: MEAL, label: 'Chicken tacos', ingredientIds: [CHICKEN] },
    ]);

    const later = await addToList(list.listId, [TOMATOES]);
    expect(((await later.json()).data as Json).sourceLabel).toBe('Chicken tacos');
  });

  it('groups same-title selections into one new unchecked row', async () => {
    await createMeal({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: [
          { ingredientId: CHICKEN, name: 'Chicken' },
          { ingredientId: TORTILLAS, name: 'chicken' },
        ],
      },
    });
    const list = await createList();

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS]);

    expect(res.status).toBe(201);
    const outcomes = ((await res.json()).data as { ingredients: Json[] }).ingredients;
    expect(outcomes.map((row) => row.outcome)).toEqual(['created', 'labelled']);
    expect(new Set(outcomes.map((row) => (row.item as Json).itemId)).size).toBe(1);
    // Both ingredients merged into the one created row, so both are recorded on it — the
    // 'labelled' outcome is not a second-class citizen as far as presence is concerned.
    const created = (await itemRows(list.listId))[0];
    expect(created?.sourceProvenance).toEqual([
      { activityId: MEAL, label: 'Chicken tacos', ingredientIds: [CHICKEN, TORTILLAS] },
    ]);
    expect(await itemRows(list.listId)).toHaveLength(1);
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
    expect(rows.filter((row) => row.state === 'open')).toHaveLength(1);
  });
});

/** §7.5, amended 2026-09-11 (founder): the label names the plan, never its day. */
describe('the label is the plan’s name', () => {
  it('does not change because another meal on the same day is on the list', async () => {
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
    expect(body.sourceLabel).toBe('Chicken tacos');
  });

  /**
   * Two different meals that share a title produce the same words. Segment ownership is by
   * `activityId`, so the second still extends the row with a segment of its own.
   */
  it('gives a same-titled second meal its own segment', async () => {
    const { list } = await setUp();
    await createMeal({ details: { kind: 'meal', ingredients: INGREDIENTS } }, OTHER_MEAL);

    await addToList(list.listId, [CHICKEN], {}, OTHER_MEAL);
    const res = await request('POST', `/v1/activities/${MEAL}/ingredients/add-to-list`, {
      listId: list.listId,
      ingredients: [{ ingredientId: CHICKEN }],
    });
    expect(res.status).toBe(201);

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceLabel).toBe('Chicken tacos · Chicken tacos');
    expect(rows[0]?.sourceProvenance).toEqual([
      { activityId: OTHER_MEAL, label: 'Chicken tacos', ingredientIds: [CHICKEN] },
      { activityId: MEAL, label: 'Chicken tacos', ingredientIds: [CHICKEN] },
    ]);
  });

  it('does not repeat a meal on its own row', async () => {
    const { list } = await setUp();

    await addToList(list.listId, [CHICKEN]);
    const res = await addToList(list.listId, [TOMATOES]);

    expect(((await res.json()).data as Json).sourceLabel).toBe('Chicken tacos');
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

  /** The label is the title now, so a rename is the edit most likely to tempt a recompute. */
  it('is unchanged after the source meal is renamed', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN]);
    const before = (await itemRows(list.listId))[0];

    const meal = await storedMeal();
    const res = await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      { title: 'Chicken fajitas' },
      { 'If-Match': String(meal?.updatedAt) },
    );
    expect(res.status).toBe(200);

    expect((await itemRows(list.listId))[0]).toEqual(before);
    expect(before?.sourceLabel).toBe('Chicken tacos');
  });

  it('is unchanged after the source meal is deleted, and the item survives', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN]);
    const before = (await itemRows(list.listId))[0];

    const res = await request('DELETE', `/v1/activities/${MEAL}`);
    expect(res.status).toBe(200);

    const after = (await itemRows(list.listId))[0];
    expect(after).toEqual(before);
    expect(after?.sourceLabel).toBe('Chicken tacos');
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

    // And presence landed on those same two rows, wherever they now sit — read the way a
    // client would, not by inspecting the reordered `details.ingredients` array.
    const rows = await itemRows(list.listId);
    const chicken = rows.find((row) => row.title === 'Chicken');
    const tortillas = rows.find((row) => row.title === 'Tortillas (8)');
    const chickenItem = await getItem(list.listId, String(chicken?.itemId));
    const tortillasItem = await getItem(list.listId, String(tortillas?.itemId));
    expect(originates(chickenItem, MEAL, CHICKEN)).toBe(true);
    expect(originates(tortillasItem, MEAL, TORTILLAS)).toBe(true);
    expect(originates(chickenItem, MEAL, TOMATOES)).toBe(false);
    expect(originates(tortillasItem, MEAL, TOMATOES)).toBe(false);
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
    // The meal is never written by this action at all, so there is nothing on it a failed
    // attempt could have changed (Option B, 2026-09-16) — the assertion that mattered here is
    // the one above: no item exists to carry anyone's origin.
    expect(await itemRows(list.listId)).toHaveLength(0);
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
   * Two genuinely concurrent requests under one key. Both the middleware's in-flight marker
   * and the receipt's conditional put inside the transaction guard this, and the supplied
   * stable `itemId` guards created destinations after receipt expiry — so the assertion is about
   * storage: one row per ingredient, and one answer.
   */
  it('creates each item once when the same key arrives twice at the same moment', async () => {
    const { list } = await setUp();
    const key = crypto.randomUUID();

    const [first, second] = await Promise.all([
      addToList(list.listId, [CHICKEN, TOMATOES], { 'Idempotency-Key': key }),
      addToList(list.listId, [CHICKEN, TOMATOES], { 'Idempotency-Key': key }),
    ]);

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title).sort()).toEqual(['Chicken', 'Tomatoes']);

    // One of the two may lose the race and be answered from the winner's receipt; whichever
    // way it fell, neither is an error and both describe the same write.
    for (const response of [first, second]) expect(response.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());

    // And each item answers for its own ingredient, once — not the meal agreeing with the
    // list, since Option B (2026-09-16) put presence on the item and nothing on the meal.
    const chicken = rows.find((row) => row.title === 'Chicken');
    const tomatoes = rows.find((row) => row.title === 'Tomatoes');
    expect(
      originates(await getItem(list.listId, String(chicken?.itemId)), MEAL, CHICKEN),
    ).toBe(true);
    expect(
      originates(await getItem(list.listId, String(tomatoes?.itemId)), MEAL, TOMATOES),
    ).toBe(true);
  });

  it('creates no duplicate under a new key, because the item ids are the same', async () => {
    const { list } = await setUp();

    expect((await addToList(list.listId, [CHICKEN, TOMATOES])).status).toBe(201);
    const replay = await addToList(list.listId, [CHICKEN, TOMATOES]);

    // The second attempt finds both rows unchecked and already carrying this label, so it
    // extends nothing and creates nothing — §7.3's duplicate rule absorbing the retry.
    expect(replay.status).toBe(201);
    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.sourceLabel)).toEqual([
      'Chicken tacos',
      'Chicken tacos',
    ]);
  });

  it('keeps a deduplicated destination bound after the target is checked and renamed', async () => {
    const { list } = await setUp();
    const target = await addItem(list.listId, 'Chicken');
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);

    const changed = await request(
      'PATCH',
      `/v1/lists/${list.listId}/items/${target.itemId}`,
      { title: 'Bought chicken', state: 'done' },
    );
    expect(changed.status).toBe(200);

    const replay = await addToList(list.listId, [CHICKEN]);
    expect(replay.status).toBe(201);
    const result = ((await replay.json()).data as { ingredients: Json[] }).ingredients[0];
    expect(result).toBeDefined();
    const resultItem = (result as Json).item as Json;
    expect(resultItem.itemId).toBe(target.itemId);
    expect(resultItem.title).toBe('Bought chicken');
    expect(await itemRows(list.listId)).toHaveLength(1);
    const binding = await rawItem(
      `LIST#${list.listId}`,
      `ITEMID#${destinationItemId(CHICKEN)}`,
    );
    expect(binding).toMatchObject({ itemId: target.itemId, ingredientId: CHICKEN });
    expect(binding).not.toHaveProperty('ttl');
  });

  it('refuses to reuse a deduplicated destination after the target is deleted', async () => {
    const { list } = await setUp();
    const target = await addItem(list.listId, 'Chicken');
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);
    expect(
      (await request('DELETE', `/v1/lists/${list.listId}/items/${target.itemId}`)).status,
    ).toBe(200);

    const replay = await addToList(list.listId, [CHICKEN]);

    expect(replay.status).toBe(409);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  it('rejects reuse of a created destination id for another ingredient', async () => {
    const { list } = await setUp();
    const destination = destinationItemId(CHICKEN);
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);

    const reused = await request(
      'POST',
      `/v1/activities/${MEAL}/ingredients/add-to-list`,
      {
        listId: list.listId,
        ingredients: [{ ingredientId: TOMATOES, itemId: destination }],
      },
    );

    expect(reused.status).toBe(409);
    const rows = await itemRows(list.listId);
    expect(rows.map((row) => row.title)).toEqual(['Chicken']);
    const item = await getItem(list.listId, String(rows[0]?.itemId));
    expect(originates(item, MEAL, CHICKEN)).toBe(true);
    expect(originates(item, MEAL, TOMATOES)).toBe(false);
  });

  it('keeps a created destination bound through delete and Undo', async () => {
    const { list } = await setUp();
    const destination = destinationItemId(CHICKEN);
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);

    const removed = await request(
      'DELETE',
      `/v1/lists/${list.listId}/items/${destination}`,
    );
    expect(removed.status).toBe(200);
    const undoToken = ((await removed.json()).data as Json).undoToken;
    const restored = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken,
    });
    expect(restored.status).toBe(200);

    const reused = await request(
      'POST',
      `/v1/activities/${MEAL}/ingredients/add-to-list`,
      {
        listId: list.listId,
        ingredients: [{ ingredientId: TOMATOES, itemId: destination }],
      },
    );

    expect(reused.status).toBe(409);
    expect(await rawItem(`LIST#${list.listId}`, `ITEMID#${destination}`)).toMatchObject({
      sourceActivityId: MEAL,
      ingredientId: CHICKEN,
      outcome: 'created',
    });
  });

  it('keeps a created destination bound through clear-checked and Undo', async () => {
    const { list } = await setUp();
    const destination = destinationItemId(CHICKEN);
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);
    expect(
      (
        await request('PATCH', `/v1/lists/${list.listId}/items/${destination}`, {
          state: 'done',
        })
      ).status,
    ).toBe(200);

    const cleared = await request('POST', `/v1/lists/${list.listId}/clear-checked`);
    expect(cleared.status).toBe(200);
    const undoToken = ((await cleared.json()).data as Json).undoToken;
    const restored = await request('POST', `/v1/lists/${list.listId}/undo`, {
      undoToken,
    });
    expect(restored.status).toBe(200);

    const reused = await request(
      'POST',
      `/v1/activities/${MEAL}/ingredients/add-to-list`,
      {
        listId: list.listId,
        ingredients: [{ ingredientId: TOMATOES, itemId: destination }],
      },
    );

    expect(reused.status).toBe(409);
    expect(await rawItem(`LIST#${list.listId}`, `ITEMID#${destination}`)).toMatchObject({
      sourceActivityId: MEAL,
      ingredientId: CHICKEN,
      outcome: 'created',
    });
  });

  it('blocks ordinary item creation with an absorbed destination id', async () => {
    const { list } = await setUp();
    await addItem(list.listId, 'Chicken');
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);

    const ordinary = await request('POST', `/v1/lists/${list.listId}/items`, {
      itemId: destinationItemId(CHICKEN),
      title: 'A different item',
    });

    expect(ordinary.status).toBe(409);
    expect(await itemRows(list.listId)).toHaveLength(1);
  });

  it('creates a fresh row beside a checked and renamed replay target', async () => {
    await createMeal({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: [
          { ingredientId: CHICKEN, name: 'Chicken' },
          { ingredientId: TORTILLAS, name: 'chicken' },
        ],
      },
    });
    const list = await createList();
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);
    const targetId = destinationItemId(CHICKEN);
    expect(
      (
        await request('PATCH', `/v1/lists/${list.listId}/items/${targetId}`, {
          title: 'Bought chicken',
          state: 'done',
        })
      ).status,
    ).toBe(200);

    const replayAndFresh = await addToList(list.listId, [CHICKEN, TORTILLAS]);

    expect(replayAndFresh.status).toBe(201);
    const outcomes = ((await replayAndFresh.json()).data as { ingredients: Json[] })
      .ingredients;
    expect(outcomes).toMatchObject([
      { ingredientId: CHICKEN, item: { itemId: targetId, state: 'done' } },
      {
        ingredientId: TORTILLAS,
        outcome: 'created',
        item: { itemId: destinationItemId(TORTILLAS), state: 'open' },
      },
    ]);
    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.state === 'open')).toHaveLength(1);
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
    ['watch', 'watch-later'],
    ['meals', 'meal-ideas'],
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
          ingredients: [{ ingredientId: CHICKEN, itemId: destinationItemId(CHICKEN) }],
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
            [field]: field === 'sourceLabel' ? 'Chicken tacos' : MEAL,
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
      sourceLabel: 'Chicken tacos',
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

/**
 * The provenance the client may **not** author, and the presence the server keeps honest
 * regardless of what the meal does to itself afterward.
 *
 * `addedToListId` is deliberately still rejected on input — the field stays on the schema,
 * `deprecated`, purely so a pre-2026-09-16 stored row still parses (`mealIngredient` is a
 * `strictObject`); `mealIngredientInput` has never accepted it, and neither test below
 * depends on the marker's old write-side behaviour, which no longer exists (Option B,
 * 2026-09-16 — `docs/reports/destination-flow-simplification-20260916.md`).
 */
describe('addedToListId is rejected on input; presence lives on the item, not the meal', () => {
  it.each([
    ['create', '/v1/activities'],
    ['patch', `/v1/activities/${MEAL}`],
  ])('rejects a client-supplied addedToListId on %s', async (kind, path) => {
    if (kind === 'patch') await createMeal();
    const details = {
      kind: 'meal',
      mealSlot: 'dinner',
      ingredients: [
        {
          ingredientId: CHICKEN,
          name: 'Chicken',
          addedToListId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1D9',
        },
      ],
    };

    const res =
      kind === 'create'
        ? await request('POST', path, {
            activityId: OTHER_MEAL,
            objectKind: 'plan',
            type: 'meal',
            title: 'Forged',
            details,
          })
        : await request(
            'PATCH',
            path,
            { details },
            { 'If-Match': String((await storedMeal())?.updatedAt) },
          );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });

  /**
   * **Rewritten for Option B (2026-09-16).** An ordinary edit — renaming an ingredient,
   * fixing a quantity, reordering — used to wipe every marker, because `PATCH` replaces
   * `details` wholesale and the client cannot send the field back; the server used to retain
   * them by matching `ingredientId`. There is nothing left to retain: presence lives on the
   * list item's own `sourceProvenance`, which this edit never touches, so the point worth
   * proving is the opposite of the old test's — that an edit to the **meal** cannot change
   * what the **item** already answers for, in either direction.
   */
  it('an ingredient edit that renames and reorders the meal does not change which items answer for it', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN, TORTILLAS]);
    const rows = await itemRows(list.listId);
    const chickenItemId = rows.find((row) => row.title === 'Chicken')?.itemId;
    const tortillasItemId = rows.find((row) => row.title === 'Tortillas (8)')?.itemId;

    const res = await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      {
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [
            { ingredientId: SOUR_CREAM, name: 'Sour cream' },
            { ingredientId: TOMATOES, name: 'Vine tomatoes' },
            { ingredientId: TORTILLAS, name: 'Corn tortillas', quantity: '12' },
            { ingredientId: CHICKEN, name: 'Chicken thighs' },
          ],
        },
      },
      { 'If-Match': String((await storedMeal())?.updatedAt) },
    );
    expect(res.status).toBe(200);

    const chickenItem = await getItem(list.listId, String(chickenItemId));
    const tortillasItem = await getItem(list.listId, String(tortillasItemId));
    expect(originates(chickenItem, MEAL, CHICKEN)).toBe(true);
    expect(originates(tortillasItem, MEAL, TORTILLAS)).toBe(true);
    expect(originates(chickenItem, MEAL, TOMATOES)).toBe(false);

    // The edit itself still applied to the meal.
    const byId = new Map(
      (await storedIngredients()).map((row) => [row.ingredientId, row]),
    );
    expect(byId.get(CHICKEN)?.name).toBe('Chicken thighs');
    expect(byId.get(TORTILLAS)?.quantity).toBe('12');
  });

  /**
   * A replaced ingredient id must not inherit the old one's presence just because a later
   * row happens to share its title — identity is the `ingredientId` recorded at add time,
   * never a title match recomputed later.
   */
  it('a replaced ingredient id does not inherit the old one’s presence on the list', async () => {
    const { list } = await setUp();
    await addToList(list.listId, [CHICKEN]);
    const chickenRow = (await itemRows(list.listId))[0];

    await request(
      'PATCH',
      `/v1/activities/${MEAL}`,
      {
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [{ ingredientId: SOUR_CREAM, name: 'Chicken' }],
        },
      },
      { 'If-Match': String((await storedMeal())?.updatedAt) },
    );

    const item = await getItem(list.listId, String(chickenRow?.itemId));
    expect(originates(item, MEAL, CHICKEN)).toBe(true);
    expect(originates(item, MEAL, SOUR_CREAM)).toBe(false);

    const ingredients = await storedIngredients();
    expect(ingredients).toHaveLength(1);
    expect(ingredients[0]).not.toHaveProperty('addedToListId');
  });
});

/**
 * The atomicity the rewrite exists for.
 *
 * The first version committed list rows and the receipt, then wrote the meal's provenance
 * separately. A same-key retry after that gap replayed the stored response and never ran the
 * write, so the meal permanently disagreed with the list. There is now one transaction, so
 * the two facts cannot be stored apart — asserted by reading storage directly rather than by
 * trusting the response.
 */
describe('one commit, or none', () => {
  it('never stores a receipt without the item provenance it describes', async () => {
    const { list } = await setUp();
    const key = crypto.randomUUID();

    await addToList(list.listId, [CHICKEN, TORTILLAS], { 'Idempotency-Key': key });

    expect(await receiptFor(key)).toBeDefined();
    const items = await Promise.all(
      (await itemRows(list.listId)).map((row) =>
        getItem(list.listId, String(row.itemId)),
      ),
    );
    expect(items.some((item) => originates(item, MEAL, CHICKEN))).toBe(true);
    expect(items.some((item) => originates(item, MEAL, TORTILLAS))).toBe(true);
  });

  it('caps one operation at MAX_INGREDIENTS_PER_ADD', async () => {
    const { list } = await setUp();

    const res = await request('POST', `/v1/activities/${MEAL}/ingredients/add-to-list`, {
      listId: list.listId,
      ingredients: Array.from({ length: MAX_INGREDIENTS_PER_ADD + 1 }, (_, index) => ({
        ingredientId: CHICKEN,
        itemId: `itm_01J8XKQ2M4N5P6R7S8T9V0W${String(index).padStart(2, '0')}`,
      })),
    });

    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
  });

  it('commits the exact 30-selection maximum within one DynamoDB transaction', async () => {
    const ingredients = Array.from({ length: MAX_INGREDIENTS_PER_ADD }, (_, index) => ({
      ingredientId: `ing_01J8XKQ2M4N5P6R7S8T9V0W${String(index).padStart(3, '0')}`,
      name: `Ingredient ${String(index)}`,
    }));
    await createMeal({ details: { kind: 'meal', ingredients } });
    const list = await createList();

    const res = await addToList(
      list.listId,
      ingredients.map((ingredient) => ingredient.ingredientId),
    );

    expect(res.status).toBe(201);
    expect(await itemRows(list.listId)).toHaveLength(MAX_INGREDIENTS_PER_ADD);
  });

  it('accepts a request with no destination item id and mints one on creation', async () => {
    const { list } = await setUp();

    const res = await request('POST', `/v1/activities/${MEAL}/ingredients/add-to-list`, {
      listId: list.listId,
      ingredients: [{ ingredientId: CHICKEN }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()).data as { ingredients: Json[] };
    expect(body.ingredients[0]).toBeDefined();
    const created = (body.ingredients[0] as Json).item as Json;
    expect(String(created.itemId)).toMatch(/^itm_/);
    expect(await itemRows(list.listId)).toHaveLength(1);
  });

  it('stores and returns a 200-character unscheduled meal title as provenance', async () => {
    await createMeal({ title: 'M'.repeat(200), schedule: undefined });
    const list = await createList();

    const res = await addToList(list.listId, [CHICKEN]);

    expect(res.status).toBe(201);
    expect(((await res.json()).data as Json).sourceLabel).toBe('M'.repeat(200));
    expect((await itemRows(list.listId))[0]?.sourceLabel).toBe('M'.repeat(200));
  });
});

/**
 * The two races that only exist **between** the service's reads and its commit, injected
 * rather than hoped for.
 *
 * `planListItemWrites` is the seam: by the time it runs the meal has been read, the
 * destination validated, the ingredient ids resolved and the list classified — and nothing
 * has been written. A wrapper that mutates storage there, once, puts a real concurrent change
 * in exactly the window the conditions exist to catch, on the real table.
 *
 * The earlier version of the stale-meal test patched the meal *before* sending the request,
 * so the handler read the already-changed array and refused it during selection. That proves
 * the selection guard, which is worth proving, and proves nothing at all about whether a
 * transaction condition failure rolls back the rows, the provenance and the receipt together
 * (raised in review). These do.
 */
describe('a change landing between the read and the commit', () => {
  /** Runs `injected` the first time the service reaches rank allocation, then calls through. */
  const injectOnce = async (injected: () => Promise<unknown>) => {
    const listRepository = await import('../../src/repositories/listRepository.js');
    const original = listRepository.planListItemWrites;
    let fired = false;
    return vi
      .spyOn(listRepository, 'planListItemWrites')
      .mockImplementation(async (...args) => {
        if (!fired) {
          fired = true;
          await injected();
        }
        return original(...args);
      });
  };

  /** Runs `injected` after the preflight List read but before the fenced snapshot. */
  const injectBeforeSnapshot = async (injected: () => Promise<unknown>) => {
    const listRepository = await import('../../src/repositories/listRepository.js');
    const original = listRepository.snapshotListItems;
    let fired = false;
    return vi
      .spyOn(listRepository, 'snapshotListItems')
      .mockImplementation(async (...args) => {
        if (!fired) {
          fired = true;
          await injected();
        }
        return original(...args);
      });
  };

  /**
   * Runs `injected` before **every** attempt, unlike {@link injectOnce} — so a fence that
   * keeps failing exhausts every one of `ATTEMPTS` rather than succeeding on the retry.
   */
  const injectEveryAttempt = async (injected: () => Promise<unknown>) => {
    const listRepository = await import('../../src/repositories/listRepository.js');
    const original = listRepository.planListItemWrites;
    return vi
      .spyOn(listRepository, 'planListItemWrites')
      .mockImplementation(async (...args) => {
        await injected();
        return original(...args);
      });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refuses a destination that stops using checkbox presentation before the fenced snapshot', async () => {
    const { list } = await setUp();
    const spy = await injectBeforeSnapshot(async () => {
      const meta = (await rawItem(`LIST#${list.listId}`, 'META')) as Json;
      const changed = await request(
        'PATCH',
        `/v1/lists/${list.listId}`,
        {
          itemStateMode: {
            mode: 'stages',
            labels: { open: 'Saved', active: 'In progress', done: 'Done' },
            groupByState: false,
          },
        },
        { 'If-Match': String(meta.updatedAt), 'Idempotency-Key': crypto.randomUUID() },
      );
      expect(changed.status).toBe(200);
    });

    const res = await addToList(list.listId, [CHICKEN]);

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(await itemRows(list.listId)).toHaveLength(0);
    expect((await rawItem(`LIST#${list.listId}`, 'META'))?.itemStateMode).toMatchObject({
      mode: 'stages',
    });
  });

  /**
   * The P1. A matching row appears after classification said "absent, create one". The
   * snapshot's `rankVersion` is the version the transaction must commit under, so the create
   * cannot be laundered through a newer one — the attempt reclassifies and extends instead.
   */
  it('does not duplicate a title another writer added after classification', async () => {
    const { list } = await setUp();

    const spy = await injectOnce(() => addItem(list.listId, 'Chicken'));
    const res = await addToList(list.listId, [CHICKEN]);

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(201);

    const rows = await itemRows(list.listId);
    const chicken = rows.filter((row) => String(row.title).toLowerCase() === 'chicken');
    expect(chicken).toHaveLength(1);
    // Reclassified: the row that appeared is unchecked, so it was labelled, not duplicated.
    expect(chicken[0]?.sourceLabel).toBe('Chicken tacos');
    expect(
      ((await res.json()).data as { ingredients: Json[] }).ingredients[0]?.outcome,
    ).toBe('labelled');
  });

  /**
   * `rankVersion` does not move for a field PATCH. `itemVersion` is the second fence that
   * makes a rename into a title classified as absent force a new classification.
   */
  it('does not duplicate a title another writer renamed after classification', async () => {
    const { list } = await setUp();
    const existing = await addItem(list.listId, 'Milk');

    const spy = await injectOnce(async () => {
      const before = (await rawItem(`LIST#${list.listId}`, 'META')) as Json;
      const patched = await request(
        'PATCH',
        `/v1/lists/${list.listId}/items/${existing.itemId}`,
        { title: 'Chicken' },
      );
      expect(patched.status).toBe(200);
      const after = (await rawItem(`LIST#${list.listId}`, 'META')) as Json;
      expect(after.rankVersion).toBe(before.rankVersion);
      expect(after.itemVersion).toBe(Number(before.itemVersion) + 1);
    });
    const res = await addToList(list.listId, [CHICKEN]);

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(201);
    const chicken = (await itemRows(list.listId)).filter(
      (row) => String(row.title).toLowerCase() === 'chicken',
    );
    expect(chicken).toHaveLength(1);
    expect(chicken[0]?.itemId).toBe(existing.itemId);
    expect(chicken[0]?.sourceLabel).toBe('Chicken tacos');
  });

  /**
   * The meal's own version moves in the window. The transaction's condition on the read
   * `updatedAt` fails, the whole attempt rolls back, and the retry re-reads and commits — so
   * the observable outcome is success with exactly one row, not two.
   */
  it('rolls back and retries when the meal changes under it', async () => {
    const { list } = await setUp();

    const spy = await injectOnce(async () =>
      request(
        'PATCH',
        `/v1/activities/${MEAL}`,
        { title: 'Chicken tacos, revised' },
        { 'If-Match': String((await storedMeal())?.updatedAt) },
      ),
    );
    const res = await addToList(list.listId, [CHICKEN, TORTILLAS]);

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(201);

    const rows = await itemRows(list.listId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.title).sort()).toEqual(['Chicken', 'Tortillas (8)']);

    const chicken = rows.find((row) => row.title === 'Chicken');
    const tortillas = rows.find((row) => row.title === 'Tortillas (8)');
    expect(
      originates(await getItem(list.listId, String(chicken?.itemId)), MEAL, CHICKEN),
    ).toBe(true);
    expect(
      originates(await getItem(list.listId, String(tortillas?.itemId)), MEAL, TORTILLAS),
    ).toBe(true);
  });

  /**
   * The load-bearing half of the fence (Option B, 2026-09-16): `ingredientMealUnchangedCheck`
   * writes nothing, but a `ConditionCheck` failure still cancels the **whole** transaction,
   * every time. Patch the meal before every one of `ATTEMPTS` commits and the operation must
   * give up with the retryable conflict, having written nothing at all — not "nothing except
   * a marker", literally nothing, because there was never anything on the Activity side to
   * write in the first place.
   */
  it('exhausts every retry and writes nothing when the meal keeps changing under it', async () => {
    const { list } = await setUp();

    const spy = await injectEveryAttempt(async () => {
      const meal = await storedMeal();
      const patched = await request(
        'PATCH',
        `/v1/activities/${MEAL}`,
        { title: `Chicken tacos, revised ${crypto.randomUUID()}` },
        { 'If-Match': String(meal?.updatedAt) },
      );
      expect(patched.status).toBe(200);
    });

    const key = crypto.randomUUID();
    const res = await addToList(list.listId, [CHICKEN, TORTILLAS], {
      'Idempotency-Key': key,
    });

    expect(spy).toHaveBeenCalledTimes(3);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('internal');
    expect(res.headers.get('Retry-After')).toBe('1');
    expect(await itemRows(list.listId)).toHaveLength(0);
    expect(await receiptFor(key)).toBeUndefined();
  });

  /**
   * And when the retry cannot succeed — the selected row is gone by the time it re-reads —
   * the first attempt's transaction must have left **nothing**: no row, no label on the
   * pre-existing row, and no receipt.
   */
  it('leaves no row, no label and no receipt when the selected row disappears', async () => {
    const { list } = await setUp();
    const existing = await addItem(list.listId, 'Tortillas (8)');
    const before = await itemRows(list.listId);

    const spy = await injectOnce(async () =>
      request(
        'PATCH',
        `/v1/activities/${MEAL}`,
        {
          details: {
            kind: 'meal',
            mealSlot: 'dinner',
            ingredients: INGREDIENTS.filter((row) => row.ingredientId !== CHICKEN),
          },
        },
        { 'If-Match': String((await storedMeal())?.updatedAt) },
      ),
    );
    const key = crypto.randomUUID();
    const res = await addToList(list.listId, [CHICKEN, TORTILLAS], {
      'Idempotency-Key': key,
    });

    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(400);

    // The pre-existing row is byte-identical: no label was extended by the failed attempt,
    // and there is nothing on the meal a failed attempt could have changed either way.
    expect(await itemRows(list.listId)).toEqual(before);
    expect(before.map((row) => row.itemId)).toEqual([existing.itemId]);
    // And the second thing this test is named for: the receipt rode in the same transaction,
    // so a rolled-back attempt must leave none under its key.
    expect(await receiptFor(key)).toBeUndefined();
  });
});

/**
 * A tombstoned id belongs to its retained Undo, and to nothing else (§P3-10, §P3-17's
 * "only the matching retained Undo may reclaim an item id protected by `ITEM_TOMBSTONE#`").
 *
 * The create path has always honoured that: every created row carries a tombstone
 * `ConditionCheck`. The **binding** path did not, and it writes to the same `ITEMID#` key —
 * so an ingredient whose supplied destination id happened to be tombstoned could occupy that
 * id by being absorbed into a different row, and the delete's Undo then had nowhere to put
 * the item back (raised in review).
 */
describe('a tombstoned destination id', () => {
  /** Adds an item under an id the caller chooses, so the test can tombstone that exact id. */
  const addItemWithId = async (listId: string, itemId: string, title: string) => {
    const res = await request('POST', `/v1/lists/${listId}/items`, { itemId, title });
    expect(res.status).toBe(201);
    return (await res.json()).data as ListItem;
  };

  const deleteItem = async (listId: string, itemId: string) => {
    const res = await request('DELETE', `/v1/lists/${listId}/items/${itemId}`);
    expect(res.status).toBe(200);
    return (await res.json()).data as { undoToken: string };
  };

  const undo = (listId: string, undoToken: string) =>
    request('POST', `/v1/lists/${listId}/undo`, { undoToken });

  const setUpTombstoned = async () => {
    await createMeal();
    const list = await createList();
    // The row the ingredient will be absorbed into: same title, unchecked.
    const absorbing = await addItem(list.listId, 'Chicken');
    // The row whose id is about to become tombstoned — and which the request will supply.
    const doomed = await addItemWithId(
      list.listId,
      destinationItemId(CHICKEN),
      'Something else',
    );
    const { undoToken } = await deleteItem(list.listId, doomed.itemId);
    return { list, absorbing, doomed, undoToken };
  };

  it('is refused, and the absorbing row is left byte-identical', async () => {
    const { list, doomed } = await setUpTombstoned();
    const before = await itemRows(list.listId);
    const key = crypto.randomUUID();

    const res = await addToList(list.listId, [CHICKEN], { 'Idempotency-Key': key });

    expect(res.status).toBe(409);
    expect(await itemRows(list.listId)).toEqual(before);
    expect(
      await rawItem(`LIST#${list.listId}`, `ITEMID#${doomed.itemId}`),
    ).toBeUndefined();
    expect(await receiptFor(key)).toBeUndefined();
  });

  /** The point of refusing: the Undo that owns that id still works. */
  it('leaves the retained Undo able to restore the deleted item', async () => {
    const { list, doomed, undoToken } = await setUpTombstoned();

    await addToList(list.listId, [CHICKEN]);
    const restored = await undo(list.listId, undoToken);

    expect(restored.status).toBe(200);
    const rows = await itemRows(list.listId);
    expect(rows.map((row) => row.itemId).sort()).toEqual(
      [
        doomed.itemId,
        ...rows.map((row) => row.itemId).filter((id) => id !== doomed.itemId),
      ].sort(),
    );
    expect(rows.some((row) => row.itemId === doomed.itemId)).toBe(true);
    expect(rows.find((row) => row.itemId === doomed.itemId)?.title).toBe(
      'Something else',
    );
  });

  /**
   * The same id, once its Undo has been spent, is still not free — the tombstone is retained
   * for the replay window. This is the create path's rule, asserted for the binding path.
   */
  it('stays refused for a destination whose Undo has already been used', async () => {
    const { list, undoToken } = await setUpTombstoned();
    expect((await undo(list.listId, undoToken)).status).toBe(200);
    // Undo restored the row, so the id is live again rather than tombstoned; deleting it a
    // second time re-tombstones it and the refusal must hold.
    await deleteItem(list.listId, destinationItemId(CHICKEN));

    const res = await addToList(list.listId, [CHICKEN]);

    expect(res.status).toBe(409);
  });
});

/**
 * **The ingredient action is an item writer too** (P3-47, per the founder's 2026-08-25 note
 * that the P3-33-era writers must move the card). Both of its shapes — a new row, and the
 * provenance-label extension of a row that already exists — change items, so both move
 * `lastItemActivityAt`; neither is a List-row change, so `updatedAt` stays for `If-Match`.
 */
describe('the two timestamps (P3-47)', () => {
  const stampsOf = async (listId: string) => {
    const meta = (await rawItem(`LIST#${listId}`, 'META')) as {
      updatedAt: string;
      lastItemActivityAt: string;
    };
    return { updatedAt: meta.updatedAt, lastItemActivityAt: meta.lastItemActivityAt };
  };

  it('adding ingredients moves lastItemActivityAt and leaves updatedAt byte-identical', async () => {
    const { list } = await setUp();
    const before = await stampsOf(list.listId);

    const res = await addToList(list.listId, [CHICKEN, TORTILLAS]);
    expect(res.status).toBe(201);

    const after = await stampsOf(list.listId);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.lastItemActivityAt).not.toBe(before.lastItemActivityAt);
  });

  it('extending an existing row’s provenance label moves it again', async () => {
    const { list } = await setUp();
    expect((await addToList(list.listId, [CHICKEN])).status).toBe(201);
    const between = await stampsOf(list.listId);
    // A second meal on another day adds the same ingredient to a row that is not `done`.
    await createMeal(
      {
        title: 'Chicken salad',
        schedule: {
          date: addWallDays(SUNDAY, 4),
          time: '12:00',
          timezone: 'America/New_York',
        },
      },
      OTHER_MEAL,
    );

    // Same ingredient, no destination id: the service finds the live row and extends it.
    const res = await request(
      'POST',
      `/v1/activities/${OTHER_MEAL}/ingredients/add-to-list`,
      {
        listId: list.listId,
        ingredients: [{ ingredientId: CHICKEN }],
      },
    );
    expect(res.status).toBe(201);

    const after = await stampsOf(list.listId);
    expect(after.updatedAt).toBe(between.updatedAt);
    expect(after.lastItemActivityAt).not.toBe(between.lastItemActivityAt);
  });
});
