import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders } from '../support/api';

/**
 * Both routes to a list item, and neither of them choosing the destination (P3-27,
 * acceptance criterion 33).
 *
 * ## What only an E2E test proves here
 *
 * `ComposeScreen.test.tsx` proves the picker comes before the form and
 * `ListDetailScreen.test.tsx` proves the add row names its list. What neither can prove is
 * that **the list on the button is the list the row lands in** — that is the path id on a real
 * request, and it is the one thing a defaulting bug would get wrong invisibly.
 *
 * So the same four words, `Try Zahav`, go in through both routes, and each time the assertion
 * is made against the server: the item is in the list the user named, and **not** in the other
 * one. A `groceries` list is seeded first precisely because it carries the `groceries` slot —
 * the closest thing in the product to a default destination — and it is proved not to be
 * pre-selected by either route (ADR-033).
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

async function expectNoSeriousA11yViolations(page: Page, where: string): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter(
    (violation) => violation.impact === 'serious' || violation.impact === 'critical',
  );
  expect(
    blocking.flatMap((violation) =>
      violation.nodes.map(
        (node) =>
          `${violation.id} (${violation.impact}) at ${node.target.join(' ')}: ` +
          `${node.failureSummary?.replace(/\s+/g, ' ').trim() ?? violation.help}`,
      ),
    ),
    `axe-core found serious or critical violations on ${where}`,
  ).toEqual([]);
}

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
  const body = (await response.json()) as { data: { listId: string } };
  return body.data.listId;
}

async function itemTitles(request: APIRequestContext, listId: string): Promise<string[]> {
  const response = await request.get(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(),
  });
  expect(response.ok(), await response.text()).toBe(true);
  // `api-contract.md` §2.7: a page carries the caller's `viewerLink`/`viewerPlan` pair beside
  // each item, so an entry is `{ item, … }` rather than a bare item.
  const body = (await response.json()) as { data: { item: { title: string } }[] };
  return body.data.map((entry) => entry.item.title);
}

test('a list item lands in the list the user named, from either route', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const restaurants = `Restaurants to try ${stamp}`;
  const groceries = `Groceries ${stamp}`;
  const quickList = `Quick list ${stamp}`;
  const title = `Try Zahav ${stamp}`;

  /**
   * The `groceries` template carries the `groceries` slot — the product's only destination
   * marker — and this list is created **first** and touched **last**, so it is both the
   * plausible default and the most recent. Neither may pre-select it.
   */
  const groceriesId = await createList(request, groceries, 'groceries');
  const restaurantsId = await createList(request, restaurants, 'places-to-visit');

  const requests: string[] = [];
  page.on('request', (sent) => requests.push(`${sent.method()} ${sent.url()}`));

  await page.goto('/lists');
  await expect(testId(page, 'lists-screen')).toBeVisible();

  // ---- Route one: global `+` → `List item` --------------------------------------
  await testId(page, 'global-add').click();
  await page.getByRole('button', { name: /^List item,/ }).click();

  // Assertion 1: fields and the required unselected destination share one composer.
  await expect(testId(page, 'list-destination-chooser')).toBeVisible();
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect(testId(page, 'compose-title')).toBeVisible();
  await expect(testId(page, 'compose-item-note')).toBeVisible();
  await expect(page.getByText('Which list?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Photos' })).toHaveCount(0);
  expect(requests.filter((line) => /capture/.test(line))).toEqual([]);
  await expectNoSeriousA11yViolations(page, '/compose (global list item)');

  // Assertion 2: nothing is pre-selected — not the slot-carrying list, not the recent one.
  for (const listId of [groceriesId, restaurantsId]) {
    const row = testId(page, `list-destination-${listId}`);
    await expect(row).toBeVisible();
    await expect(row).not.toHaveAttribute('aria-selected', /.*/);
    await expect(row).toHaveAttribute('aria-pressed', 'false');
  }

  await testId(page, 'compose-title').fill(title);
  await testId(page, 'compose-item-note').fill('Dinner shortlist');

  // Creating a destination uses the ordinary unselected catalogue, then returns here intact.
  await testId(page, 'list-destination-new').click();
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(testId(page, 'new-list-title')).toHaveCount(0);
  await testId(page, 'list-style-blank').click();
  await testId(page, 'new-list-title').fill(quickList);
  await testId(page, 'new-list-create').click();
  await expect(testId(page, 'compose-title')).toHaveValue(title);
  await expect(testId(page, 'compose-item-note')).toHaveValue('Dinner shortlist');
  await expect(page.getByRole('button', { name: `Add to ${quickList}` })).toBeVisible();

  await testId(page, `list-destination-${restaurantsId}`).click();

  // Assertion 3: selection stays in place, preserves fields, and unlocks capture plus commit.
  await expect(testId(page, 'compose-title')).toHaveValue(title);
  await expect(testId(page, 'compose-item-note')).toHaveValue('Dinner shortlist');
  await expect(page.getByRole('button', { name: 'Photos' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/compose (item form)');
  await page.getByRole('button', { name: `Add to ${restaurants}` }).click();

  await expect(testId(page, 'lists-screen')).toBeVisible();
  expect(await itemTitles(request, restaurantsId)).toEqual([title]);
  // The seeded slot-carrying list is untouched, which is the defaulting bug's signature.
  expect(await itemTitles(request, groceriesId)).toEqual([]);

  // ---- Route two: `+ Add an item` inside another list ----------------------------
  await page.goto(`/lists/${groceriesId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();

  // The compact empty state: stored guidance and one primary contextual action.
  await expect(page.getByText('Start with one item')).toBeVisible();
  await expect(page.getByText('Add something to buy.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add item' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, '/lists/:id (empty)');

  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(testId(page, 'list-contextual-add')).toBeVisible();
  await expect(testId(page, 'list-detail')).toBeAttached();
  await expect(testId(page, 'list-destination-chooser')).toHaveCount(0);
  const field = testId(page, 'list-contextual-add-title');
  await expect(field).toBeVisible();
  await field.fill(title);
  await testId(page, 'list-contextual-add-note').fill('Buy two');
  await page.getByRole('button', { name: `Add to ${groceries}` }).click();

  // Assertion 4: the same words, entered in a different list, stay in that list.
  await expect(page.getByText(title)).toBeVisible();
  expect(await itemTitles(request, groceriesId)).toEqual([title]);
  expect(await itemTitles(request, restaurantsId)).toEqual([title]);

  // Assertion 5: no suggestion or capture request fired on either route.
  expect(requests.filter((line) => /capture|suggest/.test(line))).toEqual([]);
});
