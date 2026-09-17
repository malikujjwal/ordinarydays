import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders, wallDate } from '../support/api';

/**
 * P3-43 — the explicit Plan-to-list side effects: Meal ingredients to a grocery list, and
 * a Watch Plan's `Also add to…` item. Every write happens behind the named confirmation;
 * the destination is always visible before it; nothing is written by the picker itself.
 *
 * The four grocery resolutions (`plans-and-lists.md` §5.8): one list — named, no question;
 * two and no default — asked once, remembered, not asked again; a one-off change from the
 * `▾` — writes elsewhere, leaves the default alone; none — `Create list` writes no
 * ingredient, only the later `Add n to <list>` does. Then the Watch destination, including
 * the none case where the catalogue is constrained to `Watch Later` and still unselected.
 */

const testId = (page: Page, id: string) => page.getByTestId(id);

async function createList(
  request: APIRequestContext,
  title: string,
  templateKey: string,
): Promise<string> {
  const response = await request.post(`${API}/v1/lists`, {
    headers: e2eHeaders(randomUUID()),
    data: { title, templateKey },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { listId: string } }).data.listId;
}

async function deleteList(request: APIRequestContext, listId: string): Promise<void> {
  await request.delete(`${API}/v1/lists/${listId}`, {
    headers: e2eHeaders(randomUUID()),
  });
}

type ItemSummary = { title: string; sourceLabel?: string };

/** The item page carries `{ item, viewerLink?, viewerPlan? }` rows; only the item matters here. */
async function listItems(
  request: APIRequestContext,
  listId: string,
): Promise<ItemSummary[]> {
  const response = await request.get(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(),
  });
  expect(response.ok()).toBe(true);
  const rows = (
    (await response.json()) as { data: (ItemSummary | { item: ItemSummary })[] }
  ).data;
  return rows.map((row) => ('item' in row ? row.item : row));
}

async function listIds(request: APIRequestContext): Promise<string[]> {
  const response = await request.get(`${API}/v1/lists`, { headers: e2eHeaders() });
  return ((await response.json()) as { data: { listId: string }[] }).data.map(
    (l) => l.listId,
  );
}

async function clearDefaults(request: APIRequestContext): Promise<void> {
  const response = await request.patch(`${API}/v1/me`, {
    headers: e2eHeaders(),
    data: { defaultLists: { groceries: null, watch: null } },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function me(request: APIRequestContext) {
  const response = await request.get(`${API}/v1/me`, { headers: e2eHeaders() });
  return ((await response.json()) as { data: { defaultLists?: Record<string, string> } })
    .data;
}

/** Global `+` → Plan → Meal, then two ingredients typed on the form. */
async function openMealForm(page: Page, title: string, ingredients: readonly string[]) {
  await page.goto('/plans');
  await testId(page, 'global-add').click();
  await testId(page, 'compose-title').fill(title);
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^Meal,/ }).click();
  await expect(testId(page, 'compose-form')).toBeVisible();
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await page.getByRole('button', { name: /^More options/ }).click();
  for (const [index, name] of ingredients.entries()) {
    await page.getByRole('button', { name: 'Add an ingredient' }).click();
    await page.getByRole('textbox', { name: `Ingredient ${index + 1}` }).fill(name);
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ request }) => {
  await clearDefaults(request);
  for (const listId of await listIds(request)) await deleteList(request, listId);
});

test('one grocery list: the row names it, nothing is asked, and the write lands there', async ({
  page,
  request,
}) => {
  const groceries = await createList(request, 'Groceries', 'groceries');
  await openMealForm(page, 'Chicken tacos', ['Chicken', 'Tortillas']);

  // Every ingredient starts unchecked; the destination is already named.
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Groceries');
  await expect(page.getByRole('checkbox', { name: 'Chicken' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.getByRole('button', { name: 'Create plan' })).toBeVisible();

  await page.getByRole('checkbox', { name: 'Chicken' }).click();
  await page.getByRole('checkbox', { name: 'Tortillas' }).click();
  await expect(
    page.getByRole('button', { name: 'Save plan and add 2 items to Groceries' }),
  ).toBeVisible();
  expect(await listItems(request, groceries)).toHaveLength(0);

  await page
    .getByRole('button', { name: 'Save plan and add 2 items to Groceries' })
    .click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect
    .poll(async () => (await listItems(request, groceries)).map((i) => i.title).sort())
    .toEqual(['Chicken', 'Tortillas']);
  expect((await me(request)).defaultLists?.groceries).toBeUndefined();
});

test('two lists, no default: one flat picker, and the choice becomes the default', async ({
  page,
  request,
}) => {
  const groceries = await createList(request, 'Groceries', 'groceries');
  const costco = await createList(request, 'Costco', 'groceries');

  await openMealForm(page, 'Chicken tacos', ['Chicken']);
  // Nothing is asked up front: with two capable lists and no default the row invites a
  // choice, and the picker lists every capable list in one flat list — no question step, no
  // `Remember this choice` control, no `Choose another list` escape (Option B1).
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Choose or create a list');
  await testId(page, 'compose-ingredient-destination-destination').click();
  await expect(page.getByRole('heading', { name: 'Choose a list' })).toBeVisible();
  await expect(testId(page, 'destination-sheet-remember')).toHaveCount(0);
  await testId(page, `destination-sheet-list-${costco}`).click();
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Costco');
  // Choosing is what remembers: one profile write, one name-the-list toast, and the pick
  // itself stands for this plan regardless of what the write does.
  await expect(
    page.getByText('Costco is now your default list for ingredients.'),
  ).toBeVisible();
  await expect.poll(async () => (await me(request)).defaultLists?.groceries).toBe(costco);

  await page.getByRole('checkbox', { name: 'Chicken' }).click();
  await page.getByRole('button', { name: 'Save plan and add 1 item to Costco' }).click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect.poll(async () => (await listItems(request, costco)).length).toBe(1);
  expect(await listItems(request, groceries)).toHaveLength(0);

  // The next meal needs no choice: the default answers, and is still shown.
  await openMealForm(page, 'Chicken soup', ['Stock']);
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Costco');
  await expect(testId(page, 'destination-sheet')).toHaveCount(0);
});

test('changing the destination from the row writes elsewhere and leaves the default alone', async ({
  page,
  request,
}) => {
  const groceries = await createList(request, 'Groceries', 'groceries');
  const costco = await createList(request, 'Costco', 'groceries');
  await request.patch(`${API}/v1/me`, {
    headers: e2eHeaders(),
    data: { defaultLists: { groceries: costco } },
  });

  await openMealForm(page, 'Chicken tacos', ['Chicken']);
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Costco');
  await testId(page, 'compose-ingredient-destination-destination').click();
  // A one-off change: the picker is the same flat list, and the stored default is untouched
  // (asserted below, after the write).
  await testId(page, `destination-sheet-list-${groceries}`).click();
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Groceries');

  await page.getByRole('checkbox', { name: 'Chicken' }).click();
  await page
    .getByRole('button', { name: 'Save plan and add 1 item to Groceries' })
    .click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect.poll(async () => (await listItems(request, groceries)).length).toBe(1);
  expect(await listItems(request, costco)).toHaveLength(0);
  expect((await me(request)).defaultLists?.groceries).toBe(costco);
});

test('no grocery list: nothing is suggested, Create list writes no ingredient, the later action does', async ({
  page,
  request,
}) => {
  await openMealForm(page, 'Chicken tacos', ['Chicken']);
  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Choose or create a list');
  await testId(page, 'compose-ingredient-destination-destination').click();
  await testId(page, 'destination-sheet-new-list').click();

  // The seven-type catalogue, nothing selected.
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await testId(page, 'list-style-groceries').click();
  await testId(page, 'new-list-create').click();

  await expect(
    testId(page, 'compose-ingredient-destination-destination-name'),
  ).toHaveText('Groceries');
  const [groceries] = await listIds(request);
  expect(groceries).toBeDefined();
  expect(await listItems(request, groceries as string)).toHaveLength(0);

  await page.getByRole('checkbox', { name: 'Chicken' }).click();
  await page
    .getByRole('button', { name: 'Save plan and add 1 item to Groceries' })
    .click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect
    .poll(async () => (await listItems(request, groceries as string)).length)
    .toBe(1);
});

/** Global `+` → Plan → Watch with a title; the toggle is off in every context. */
async function openWatchForm(page: Page, title: string) {
  await page.goto('/plans');
  await testId(page, 'global-add').click();
  await testId(page, 'compose-title').fill(title);
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^Watch,/ }).click();
  await expect(testId(page, 'compose-form')).toBeVisible();
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await page.getByRole('button', { name: /^More options/ }).click();
  await expect(testId(page, 'watch-destination-toggle')).toHaveAttribute(
    'aria-checked',
    'false',
  );
}

test('watch, one destination: the toggle is off, turning it on names the list, the button names both writes', async ({
  page,
  request,
}) => {
  const watchLater = await createList(request, 'Watch Later', 'watch-later');
  await openWatchForm(page, 'Severance');
  await expect(page.getByRole('button', { name: 'Create plan' })).toBeVisible();

  await testId(page, 'watch-destination-toggle').click();
  await expect(testId(page, 'watch-destination-list-name')).toHaveText('Watch Later');
  await expect(
    page.getByRole('button', { name: 'Save plan and add Severance to Watch Later' }),
  ).toBeVisible();
  expect(await listItems(request, watchLater)).toHaveLength(0);

  await page
    .getByRole('button', { name: 'Save plan and add Severance to Watch Later' })
    .click();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect
    .poll(async () => (await listItems(request, watchLater)).map((i) => i.title))
    .toEqual(['Severance']);
});

test('watch, none: New list offers only Watch Later, unselected; choosing it writes no item', async ({
  page,
  request,
}) => {
  await openWatchForm(page, 'Severance');
  await testId(page, 'watch-destination-toggle').click();
  await expect(testId(page, 'watch-destination-list-name')).toHaveText(
    'Choose or create a list',
  );
  await testId(page, 'watch-destination-list').click();
  await testId(page, 'destination-sheet-new-list').click();

  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'list-style-watch-later')).toBeVisible();
  await expect(testId(page, 'list-style-groceries')).toHaveCount(0);
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await testId(page, 'list-style-watch-later').click();
  await testId(page, 'new-list-create').click();

  await expect(testId(page, 'watch-destination-list-name')).toHaveText('Watch Later');
  const [watchLater] = await listIds(request);
  expect(await listItems(request, watchLater as string)).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: 'Save plan and add Severance to Watch Later' }),
  ).toBeVisible();
});

test('meal detail: the ingredients section adds only the selected rows, then marks them Added', async ({
  page,
  request,
}) => {
  const groceries = await createList(request, 'Groceries', 'groceries');
  const ing = (n: string) => `ing_01J8XKQ2M4N5P6R7S8T9V0W1A${n}`;
  const created = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      objectKind: 'plan',
      type: 'meal',
      title: 'Chicken tacos',
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: [
          { ingredientId: ing('1'), name: 'Chicken' },
          { ingredientId: ing('2'), name: 'Tortillas', quantity: '8' },
          { ingredientId: ing('3'), name: 'Sour cream' },
        ],
      },
      schedule: { date: wallDate(), time: '19:00', timezone: 'America/New_York' },
    },
  });
  const activityId = ((await created.json()) as { data: { activityId: string } }).data
    .activityId;

  await page.goto(`/activity/${activityId}`);
  await expect(testId(page, 'section-ingredients')).toBeVisible();
  // Detail's footer layout (2026-09-10): one quiet `To Groceries ▾` line at the foot.
  await expect(testId(page, 'ingredient-picker-destination-name')).toHaveText(
    'To Groceries',
  );
  // The add action appears only once a row is selected.
  await expect(testId(page, 'ingredient-picker-add')).toHaveCount(0);
  for (const name of ['Chicken', 'Tortillas (8)', 'Sour cream']) {
    await expect(page.getByRole('checkbox', { name })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  }
  await page.getByRole('checkbox', { name: 'Chicken' }).click();
  await page.getByRole('checkbox', { name: 'Tortillas (8)' }).click();
  await page.getByRole('button', { name: 'Add 2 to Groceries' }).click();

  // `Added` is presence on Groceries now (Option B, 2026-09-16), read fresh from the list
  // this add just wrote to — not a marker stored on the meal.
  await expect(testId(page, `ingredient-picker-added-${ing('1')}`)).toHaveText('Added');
  await expect(testId(page, `ingredient-picker-added-${ing('2')}`)).toHaveText('Added');
  await expect(page.getByRole('checkbox', { name: 'Sour cream' })).toBeVisible();
  const items = await listItems(request, groceries);
  expect(items.map((i) => i.title).sort()).toEqual(['Chicken', 'Tortillas (8)']);
  // §7.5, amended 2026-09-11: the provenance label is the plan's name, not its day.
  expect(items.map((i) => i.sourceLabel)).toEqual(['Chicken tacos', 'Chicken tacos']);
});
