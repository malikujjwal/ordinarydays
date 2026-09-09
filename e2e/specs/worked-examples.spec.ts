import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { agendaRow, openEarlierToday } from '../support/agenda';
import { API, e2eHeaders, wallDate, ZONE } from '../support/api';

/**
 * P3-45 — the worked examples of `plans-and-lists.md` §9 as executable flows, plus the two
 * lifecycles the phase added: a List that never links to anything, and a Plan with no date.
 *
 * Each flow chains rules that unit tests verify one at a time and nothing else verifies
 * together. Every step is the user's own explicit tap; every assertion about what was
 * written reads the API back rather than trusting the screen. Where the example names a
 * second person (Alice, Ben) the flow runs as `Just me` — the harness is one seeded user.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

type Json = Record<string, unknown>;

async function get<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`${API}${path}`, { headers: e2eHeaders() });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

async function post<T>(request: APIRequestContext, path: string, data: Json): Promise<T> {
  const response = await request.post(`${API}${path}`, {
    headers: e2eHeaders(randomUUID()),
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

interface ListRow {
  listId: string;
  title: string;
  templateKey: string;
  archived?: boolean;
  itemStateMode: { mode: string };
}

interface ItemRow {
  itemId: string;
  title: string;
  state: string;
  sourceLabel?: string;
  features?: { progress?: { kind: string; season?: number; episode?: number } };
}

interface ActivityRow {
  activityId: string;
  title: string;
  status: string;
  objectKind: string;
  schedule?: { date: string };
  details?: { ingredients?: { name: string; addedToListId?: string }[] };
}

interface PlansData {
  needsDate: { activityId: string }[];
  upcoming: { date: string; items: { activityId: string }[] }[];
  past: { date: string; items: { activityId: string }[] }[];
}

const lists = (request: APIRequestContext) => get<ListRow[]>(request, '/v1/lists');
/** The item page carries `{ item, viewerLink?, viewerPlan? }` rows; only the item matters here. */
const items = async (request: APIRequestContext, listId: string): Promise<ItemRow[]> =>
  (await get<(ItemRow | { item: ItemRow })[]>(request, `/v1/lists/${listId}/items`)).map(
    (row) => ('item' in row ? row.item : row),
  );
/** `GET /v1/activities/:id` answers with the detail envelope; only the Activity matters here. */
const activity = async (request: APIRequestContext, id: string): Promise<ActivityRow> => {
  const data = await get<ActivityRow | { activity: ActivityRow }>(
    request,
    `/v1/activities/${id}`,
  );
  return 'activity' in data ? data.activity : data;
};
const plans = (request: APIRequestContext) =>
  get<PlansData>(request, `/v1/plans?mode=initial&tz=${encodeURIComponent(ZONE)}`);
const savedActivities = (request: APIRequestContext) =>
  get<ActivityRow[]>(request, '/v1/activities?filter=saved');

/** Every Activity the account holds, across the three plans stages and the saved bucket. */
async function allActivityIds(request: APIRequestContext): Promise<string[]> {
  const data = await plans(request);
  const dated = [...data.upcoming, ...data.past].flatMap((day) =>
    day.items.map((item) => item.activityId),
  );
  const saved = (await savedActivities(request)).map((row) => row.activityId);
  return [
    ...new Set([...data.needsDate.map((row) => row.activityId), ...dated, ...saved]),
  ];
}

async function resetAccount(request: APIRequestContext): Promise<void> {
  for (const list of await lists(request)) {
    await request.delete(`${API}/v1/lists/${list.listId}`, { headers: e2eHeaders() });
  }
  for (const id of await allActivityIds(request)) {
    await request.delete(`${API}/v1/activities/${id}`, { headers: e2eHeaders() });
  }
  await request.patch(`${API}/v1/me`, {
    headers: e2eHeaders(),
    data: { defaultLists: { groceries: null, watch: null } },
  });
}

/** Lists → `New list` → an explicit style → a visible title → `Create list`. */
async function createListFromIndex(page: Page, styleKey: string, title: string) {
  await page.goto('/lists');
  await expect(testId(page, 'lists-screen')).toBeVisible();
  await testId(page, 'lists-new').click();
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await testId(page, `list-style-${styleKey}`).click();
  await testId(page, 'new-list-title').fill(title);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/v1/lists',
  );
  await testId(page, 'new-list-create').click();
  const body = (await (await created).json()) as { data: { listId: string } };
  // Back on the index before anything else navigates: a `goto` racing the sheet's own
  // return trip aborts.
  await expect(testId(page, 'lists-screen')).toBeVisible();
  await expect(page.getByText(title)).toBeVisible();
  return body.data.listId;
}

/** On an open list: `+ Add an item` → title → commit, for each title. */
async function addItems(page: Page, titles: readonly string[]) {
  for (const title of titles) {
    // An empty list offers `Add item` in its empty state; a populated one the add row.
    const composer = testId(page, 'list-contextual-add');
    if ((await composer.count()) === 0) {
      await page
        .getByRole('button', { name: /^Add (an )?item$/ })
        .first()
        .click();
    }
    await expect(composer).toBeVisible();
    await testId(page, 'list-contextual-add-title').fill(title);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().includes('/items'),
    );
    await testId(page, 'list-contextual-add-commit').click();
    await created;
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  }
}

async function openList(page: Page, listId: string) {
  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();
}

const nowInZone = () => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '00';
  return { hour: Number(value('hour')) % 24, minute: Number(value('minute')) };
};

/** A wall time earlier today, so the plan is already passed when Today renders. */
function passedTimeToday(): string {
  const { hour } = nowInZone();
  const h = Math.max(0, hour - 1);
  return `${String(h).padStart(2, '0')}:05`;
}

/** The compose form's time: the `Set a time` chip opens the clock sheet; `Done` commits. */
async function setTime(page: Page, hhmm: string) {
  await page.getByRole('button', { name: 'Set a time' }).click();
  const input = page.locator('input[aria-label="Time"]');
  await expect(input).toBeVisible();
  await input.fill(hhmm);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(input).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await resetAccount(request);
});

test('9.1 Watchlist → Today: one row, one write on the Activity, an offered update, nothing created', async ({
  page,
  request,
}) => {
  const today = wallDate();
  // Step 0: Watch Later, renamed. The preset came from the tap, not the words.
  const listId = await createListFromIndex(page, 'watch-later', 'Movies and shows');
  expect((await lists(request)).find((l) => l.listId === listId)).toMatchObject({
    title: 'Movies and shows',
    templateKey: 'watch-later',
  });

  // Step 1–2: Severance, progress S2 E4, Watching.
  await openList(page, listId);
  await addItems(page, ['Severance']);
  const [severance] = await items(request, listId);
  expect(severance).toBeDefined();
  const itemId = (severance as ItemRow).itemId;
  await testId(page, `list-item-${itemId}-body`).click();
  await expect(testId(page, 'item-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Watching' }).click();
  await page.getByRole('button', { name: /^Progress/ }).click();
  // Both fields inside one debounce window, then the one coalesced PATCH. A blur here would
  // flush a second PATCH under the list's read fence while the first is in flight, and the
  // fence refuses it (recorded for the founder in the batch notes).
  const progressSaved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      response.url().endsWith(`/items/${itemId}`) &&
      response.ok(),
  );
  await page.getByRole('textbox', { name: 'Season' }).fill('2');
  await page.getByRole('textbox', { name: 'Episode' }).fill('4');
  await progressSaved;
  await expect
    .poll(async () => (await items(request, listId))[0]?.features?.progress)
    .toMatchObject({ kind: 'episode', season: 2, episode: 4 });
  // The sheet carries no media-kind control; the worked example's `Show` is set here so the
  // second follow-up (`Create a Plan for S2 E6?`) has a show to ask about. Recorded in the PR.
  await request.patch(`${API}/v1/lists/${listId}/items/${itemId}`, {
    headers: e2eHeaders(),
    data: {
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
      },
    },
  });
  await expect.poll(async () => (await items(request, listId))[0]?.state).toBe('active');

  // Step 3–4: Plan this item → Watch (explicit) → Just me → earlier today → Save plan.
  const scheduleBodies: Json[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().endsWith(`/items/${itemId}/schedule`)) {
      scheduleBodies.push(sent.postDataJSON() as Json);
    }
  });
  await openList(page, listId);
  await testId(page, `list-item-${itemId}-body`).click();
  await testId(page, 'item-sheet-plan').click();
  await page.getByRole('button', { name: /^Watch,/ }).click();
  await page.getByRole('button', { name: /^Just me,/ }).click();
  await expect(page.getByRole('textbox', { name: 'Episode', exact: true })).toHaveValue(
    '5',
  );
  await page.getByRole('button', { name: 'Today' }).click();
  await setTime(page, passedTimeToday());
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  expect(scheduleBodies).toHaveLength(1);
  expect(scheduleBodies[0]).toMatchObject({
    creationTarget: { objectKind: 'plan', type: 'watch' },
    audience: { mode: 'just_me' },
    details: { kind: 'watch', season: 2, episode: 5 },
  });
  const activityId = (scheduleBodies[0] as { activityId: string }).activityId;
  // The item is byte-for-byte the item: still one row, still S2 E4, still active.
  const after = await items(request, listId);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({
    state: 'active',
    features: { progress: { season: 2, episode: 4 } },
  });

  // Step 5: one row, not two, and it names the session.
  await openList(page, listId);
  await expect(
    page.locator(`[data-testid^="list-item-"][data-testid$="-body"]`),
  ).toHaveCount(1);
  await expect(testId(page, `list-item-${itemId}-plan-state`)).toContainText(
    'Next session',
  );

  // Step 6–7: Today → EARLIER TODAY → `How did it go?` → Watched. One write, on the Activity.
  const before = await allActivityIds(request);
  await page.goto('/');
  await openEarlierToday(page);
  const row = agendaRow(page, activityId);
  await expect(row).toBeVisible();
  await row.getByTestId('agenda-resolution-prompt').click();
  await testId(page, 'passed-plan-positive').click();
  await expect
    .poll(async () => (await activity(request, activityId)).status)
    .toBe('completed');
  expect((await items(request, listId))[0]).toMatchObject({
    state: 'active',
    features: { progress: { season: 2, episode: 4 } },
  });

  // Step 8: the follow-up, tapped, is the one item PATCH.
  const toast = page.getByRole('alert');
  await expect(toast).toContainText(
    'Movies and shows · currently S2 E4 — Update to S2 E5?',
  );
  await testId(page, 'follow-up-update-progress').click();
  await expect
    .poll(async () => (await items(request, listId))[0]?.features?.progress)
    .toMatchObject({ season: 2, episode: 5 });

  // Step 9: the second follow-up, dismissed. Nothing is created.
  await expect(toast).toContainText('Create a Plan for S2 E6?');
  await testId(page, 'toast-dismiss').click();
  await expect(toast).toHaveCount(0);
  expect((await allActivityIds(request)).sort()).toEqual([...before].sort());
  expect(today).toBe(wallDate());
});

test('9.2 Meal → Groceries: three labelled items, Added on the meal, checking leaves the meal alone, cleared with Undo', async ({
  page,
  request,
}) => {
  const groceries = await post<ListRow>(request, '/v1/lists', {
    title: 'Groceries',
    templateKey: 'groceries',
  });
  await post(request, `/v1/lists/${groceries.listId}/items`, { title: 'Milk' });

  // Step 1–3: Plan → Meal, four ingredients, one left unchecked; the destination is named.
  await page.goto('/plans');
  await testId(page, 'global-add').click();
  await testId(page, 'compose-title').fill('Chicken tacos');
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^Meal,/ }).click();
  await page.getByRole('button', { name: 'Today' }).click();
  await setTime(page, passedTimeToday());
  await page.getByRole('button', { name: /^More options/ }).click();
  const ingredients = ['Chicken', 'Tortillas', 'Tomatoes', 'Sour cream'];
  for (const [index, name] of ingredients.entries()) {
    await page.getByRole('button', { name: 'Add an ingredient' }).click();
    await page.getByRole('textbox', { name: `Ingredient ${index + 1}` }).fill(name);
  }
  await page.getByRole('textbox', { name: 'Quantity 2' }).fill('8');
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Groceries');
  for (const name of ['Chicken', 'Tortillas (8)', 'Tomatoes']) {
    await page.getByRole('checkbox', { name }).click();
  }

  // Step 4: one named write, then the add-to-list.
  const createBodies: Json[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().endsWith('/v1/activities')) {
      createBodies.push(sent.postDataJSON() as Json);
    }
  });
  await page
    .getByRole('button', { name: 'Save plan and add 3 items to Groceries' })
    .click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  expect(createBodies).toHaveLength(1);
  expect(createBodies[0]).toMatchObject({ objectKind: 'plan', type: 'meal' });

  // Step 5: the list reads three labelled items and Milk without a label.
  await expect.poll(async () => (await items(request, groceries.listId)).length).toBe(4);
  const rows = await items(request, groceries.listId);
  const labelled = rows.filter((row) => row.sourceLabel !== undefined);
  expect(labelled.map((row) => row.title).sort()).toEqual([
    'Chicken',
    'Tomatoes',
    'Tortillas (8)',
  ]);
  // One provenance label for all three (`Chicken — Sunday dinner`): the meal's own words.
  expect(new Set(labelled.map((row) => row.sourceLabel)).size).toBe(1);
  expect(rows.find((row) => row.title === 'Milk')?.sourceLabel).toBeUndefined();

  // Step 6: the meal shows Added for three and an action for Sour cream.
  const mealId = (await plans(request)).upcoming
    .concat((await plans(request)).past)
    .flatMap((day) => day.items)[0]?.activityId as string;
  expect(mealId).toBeDefined();
  await page.goto(`/activity/${mealId}`);
  await expect(testId(page, 'section-ingredients')).toBeVisible();
  await expect(page.locator('[data-testid^="ingredient-picker-added-"]')).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: 'Sour cream' })).toBeVisible();

  // Step 7: shopping — checking the three items touches the meal not at all.
  const mealBefore = await activity(request, mealId);
  await openList(page, groceries.listId);
  for (const row of labelled) {
    await testId(page, `list-item-${row.itemId}`).getByRole('checkbox').click();
  }
  await expect
    .poll(async () =>
      (await items(request, groceries.listId))
        .filter((row) => row.sourceLabel !== undefined)
        .every((row) => row.state === 'done'),
    )
    .toBe(true);
  expect(await activity(request, mealId)).toEqual(mealBefore);

  // Step 8–9: Today → `Had it`. Nothing on any list changes.
  await page.goto('/');
  await openEarlierToday(page);
  const row = agendaRow(page, mealId);
  await expect(row).toContainText('Chicken tacos');
  await row.getByTestId('agenda-resolution-prompt').click();
  await testId(page, 'passed-plan-positive').click();
  await expect
    .poll(async () => (await activity(request, mealId)).status)
    .toBe('completed');
  expect(
    (await items(request, groceries.listId)).map((row) => [row.title, row.state]),
  ).toEqual(
    rows.map((row) => [row.title, row.sourceLabel === undefined ? 'open' : 'done']),
  );

  // Step 10: Clear checked (3) — immediate, with Undo; Milk remains.
  await openList(page, groceries.listId);
  await testId(page, 'list-detail-menu').click();
  await testId(page, 'list-clear-checked').click();
  await expect(testId(page, 'confirm-dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('3 items cleared');
  await expect(
    page.getByRole('alert').getByRole('button', { name: 'Undo' }),
  ).toBeVisible();
  await expect
    .poll(async () => (await items(request, groceries.listId)).map((row) => row.title))
    .toEqual(['Milk']);
});

test('9.3 Trip plan → Packing list: prep tasks, two plan-created lists, and both survive completion untouched', async ({
  page,
  request,
}) => {
  const today = wallDate();
  // Step 1: Plan → Event → New York Trip, tomorrow, Manhattan.
  await page.goto('/plans');
  await testId(page, 'global-add').click();
  await testId(page, 'compose-title').fill('New York Trip');
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^Event,/ }).click();
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await page.getByRole('button', { name: /^More options/ }).click();
  await testId(page, 'compose-location-label').fill('Manhattan');
  await page.getByRole('button', { name: 'Create plan' }).click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  const tripId = (await allActivityIds(request))[0] as string;
  expect(tripId).toBeDefined();
  expect(await activity(request, tripId)).toMatchObject({
    objectKind: 'plan',
    title: 'New York Trip',
  });

  // Step 2: two prep tasks from the plan's own `+ Add prep task`.
  for (const title of ['Book hotel', 'Buy tickets']) {
    await page.goto(`/activity/${tripId}`);
    await expect(testId(page, 'detail-title')).toHaveValue('New York Trip');
    const add = testId(page, 'add-to-plan-prep-task');
    if ((await add.count()) > 0) {
      await add.click();
    } else {
      await page.getByRole('button', { name: /Add prep task/ }).click();
    }
    await expect(testId(page, 'compose-form')).toBeVisible();
    await testId(page, 'compose-title').fill(title);
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(testId(page, 'compose-save')).toHaveText('Save task');
    await testId(page, 'compose-save').click();
    await expect(testId(page, 'section-prep')).toBeVisible();
  }
  await expect(page.getByText('Book hotel')).toBeVisible();
  await expect(page.getByText('Buy tickets')).toBeVisible();

  // Step 3–5: LISTS → Add list → Checklist, retitled → three items.
  await page.goto(`/activity/${tripId}`);
  const addList = testId(page, 'lists-add');
  if ((await addList.count()) > 0) {
    await addList.click();
  } else {
    await testId(page, 'add-to-plan-list').click();
  }
  await expect(testId(page, 'add-list-to-plan-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Create new list', exact: true }).click();
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await testId(page, 'list-style-checklist').click();
  await testId(page, 'new-list-title').fill('Packing · New York Trip');
  await testId(page, 'new-list-create').click();
  await expect
    .poll(async () => (await lists(request)).map((l) => l.title))
    .toContain('Packing · New York Trip');
  const packing = (await lists(request)).find(
    (l) => l.title === 'Packing · New York Trip',
  ) as ListRow;
  await openList(page, packing.listId);
  await addItems(page, ['Charger', 'Jacket', 'Passport']);

  // Step 6: back on the plan, LISTS reads the packing list with its count.
  await page.goto(`/activity/${tripId}`);
  await expect(testId(page, `plan-list-${packing.listId}`)).toContainText(
    'Packing · New York Trip',
  );
  await expect(testId(page, `plan-list-${packing.listId}`)).toContainText('3 items');

  // Step 7: a second list, Places to Visit, with two items.
  if ((await testId(page, 'lists-add').count()) > 0) {
    await testId(page, 'lists-add').click();
  } else {
    await testId(page, 'add-to-plan-list').click();
  }
  await expect(testId(page, 'add-list-to-plan-sheet')).toBeVisible();
  await page.getByRole('button', { name: 'Create new list', exact: true }).click();
  await testId(page, 'list-style-places-to-visit').click();
  await testId(page, 'new-list-create').click();
  await expect.poll(async () => (await lists(request)).length).toBe(2);
  const places = (await lists(request)).find(
    (l) => l.templateKey === 'places-to-visit',
  ) as ListRow;
  await openList(page, places.listId);
  await addItems(page, ['Central Park', 'Museum']);

  // Step 8: the prep task is on Today with the plan as its subtitle.
  const prepIds = (await allActivityIds(request)).filter((id) => id !== tripId);
  expect(prepIds).toHaveLength(2);
  await page.goto('/');
  await expect(testId(page, 'today-agenda')).toBeVisible();
  const prepRow = agendaRow(page, prepIds[0] as string);
  await expect(prepRow).toContainText('New York Trip');

  // Step 9: packed — all three checked.
  await openList(page, packing.listId);
  for (const row of await items(request, packing.listId)) {
    await testId(page, `list-item-${row.itemId}`).getByRole('checkbox').click();
  }
  await expect
    .poll(async () =>
      (await items(request, packing.listId)).every((row) => row.state === 'done'),
    )
    .toBe(true);

  // Step 10: the owner completes the trip from its detail. Both lists survive, untouched.
  const packingBefore = await items(request, packing.listId);
  const placesBefore = await items(request, places.listId);
  await page.goto(`/activity/${tripId}`);
  await testId(page, 'detail-complete').click();
  await expect
    .poll(async () => (await activity(request, tripId)).status)
    .toBe('completed');
  const survivors = await lists(request);
  expect(survivors.map((l) => [l.title, l.archived === true])).toEqual(
    expect.arrayContaining([
      ['Packing · New York Trip', false],
      [places.title, false],
    ]),
  );
  expect(await items(request, packing.listId)).toEqual(packingBefore);
  expect(await items(request, places.listId)).toEqual(placesBefore);

  // Step 11: Uncheck all, rename to Packing, and it is ready for the next trip.
  await openList(page, packing.listId);
  await testId(page, 'list-detail-menu').click();
  await testId(page, 'list-uncheck-all').click();
  await expect
    .poll(async () =>
      (await items(request, packing.listId)).every((row) => row.state === 'open'),
    )
    .toBe(true);
  const currentPacking = await get<{ list: { updatedAt: string } }>(
    request,
    `/v1/lists/${packing.listId}`,
  );
  const renamed = await request.patch(`${API}/v1/lists/${packing.listId}`, {
    headers: {
      ...e2eHeaders(randomUUID()),
      'If-Match': currentPacking.list.updatedAt,
    },
    data: { title: 'Packing' },
  });
  expect(renamed.ok(), await renamed.text()).toBe(true);
  await expect
    .poll(
      async () =>
        (await lists(request)).find((list) => list.listId === packing.listId)?.title,
    )
    .toBe('Packing');
  expect((await items(request, packing.listId)).map((row) => row.title).sort()).toEqual([
    'Charger',
    'Jacket',
    'Passport',
  ]);
  expect(today).toBe(wallDate());
});

test('a List that never links to anything: Blank is an explicit tap, rows carry no state chrome, zero Activities exist', async ({
  page,
  request,
}) => {
  const listId = await createListFromIndex(page, 'blank', 'Bars to try');
  expect((await lists(request)).find((l) => l.listId === listId)).toMatchObject({
    templateKey: 'blank',
    itemStateMode: { mode: 'none' },
  });
  await openList(page, listId);
  await addItems(page, ['Fountain Porter', 'Monk’s', 'Bar Hygge']);

  // Reopen the app: three ordinary rows, no state control, no empty feature chrome.
  await page.goto('/');
  await openList(page, listId);
  const bodies = page.locator('[data-testid^="list-item-"][data-testid$="-body"]');
  await expect(bodies).toHaveCount(3);
  await expect(testId(page, 'list-detail').getByRole('checkbox')).toHaveCount(0);
  await expect(testId(page, 'list-state-sections')).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="list-item-"][data-testid$="-plan-state"]'),
  ).toHaveCount(0);

  // Zero Activities, and nothing on Today.
  expect(await allActivityIds(request)).toEqual([]);
  await page.goto('/');
  await expect(testId(page, 'today-screen')).toBeVisible();
  await expect(testId(page, 'today-loading')).toHaveCount(0);
  for (const title of ['Fountain Porter', 'Monk’s', 'Bar Hygge']) {
    await expect(page.getByText(title)).toHaveCount(0);
  }
});

test('a Plan with no date: Needs a date and nowhere else, then a Saturday moves it to Upcoming with no badge anywhere', async ({
  page,
  request,
}) => {
  const createBodies: Json[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().endsWith('/v1/activities')) {
      createBodies.push(sent.postDataJSON() as Json);
    }
  });
  await page.goto('/plans');
  await testId(page, 'global-add').click();
  await testId(page, 'compose-title').fill('Poconos trip');
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^Event,/ }).click();
  await expect(testId(page, 'compose-save')).toHaveText('Create plan');
  await testId(page, 'compose-save').click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  expect(createBodies).toHaveLength(1);
  expect(createBodies[0]).not.toHaveProperty('schedule');
  const id = (await allActivityIds(request))[0] as string;

  // Under Needs a date, and on no other screen.
  let data = await plans(request);
  expect(data.needsDate.map((row) => row.activityId)).toEqual([id]);
  expect(data.upcoming.flatMap((day) => day.items)).toEqual([]);
  await page.goto('/plans');
  await expect(testId(page, 'plans-stage-switcher')).toHaveText(
    /^Needs a dateUpcomingPast$/,
  );
  await page.getByRole('tab', { name: 'Needs a date' }).click();
  await expect(testId(page, `plans-needs-date-${id}`)).toBeVisible();
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  await expect(testId(page, 'plans-list').getByText('Poconos trip')).toHaveCount(0);
  await page.goto('/');
  await expect(testId(page, 'today-screen')).toBeVisible();
  await expect(testId(page, 'today-loading')).toHaveCount(0);
  await expect(page.getByText('Poconos trip')).toHaveCount(0);
  await page.goto('/anytime');
  await expect(testId(page, 'anytime-screen')).toBeVisible();
  await expect(testId(page, 'anytime-screen').getByText('Poconos trip')).toHaveCount(0);

  // Give it a Saturday from its own detail.
  await page.goto(`/activity/${id}`);
  await testId(page, 'when-where-date').click();
  await expect(testId(page, 'reschedule-sheet')).toBeVisible();
  await testId(page, 'quick-date-weekend').click();
  const commit = testId(page, 'reschedule-commit');
  if ((await commit.count()) > 0 && (await commit.isVisible())) await commit.click();
  await expect
    .poll(async () => (await activity(request, id)).schedule?.date)
    .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const scheduled = (await activity(request, id)).schedule?.date as string;
  expect(new Date(`${scheduled}T12:00:00`).getDay()).toBe(6);

  // Moved to Upcoming: out of `#P`, into `#S` — read through the one projection of both.
  data = await plans(request);
  expect(data.needsDate).toEqual([]);
  expect(
    data.upcoming.flatMap((day) => day.items.map((item) => item.activityId)),
  ).toContain(id);
  await page.goto('/plans');
  await expect(testId(page, 'plans-stage-switcher')).toHaveText(
    /^Needs a dateUpcomingPast$/,
  );
  await page.getByRole('tab', { name: 'Upcoming' }).click();
  await expect(testId(page, 'plans-list').getByText('Poconos trip')).toBeVisible();
  await page.getByRole('tab', { name: 'Needs a date' }).click();
  await expect(testId(page, `plans-needs-date-${id}`)).toHaveCount(0);
  await expect(page.getByText(/\(\d+\)/)).toHaveCount(0);
});
