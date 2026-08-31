import { randomUUID } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders } from '../support/api';

/**
 * Global Add creates a List; List-item creation remains contextual to an open List.
 *
 * ## What only an E2E test proves here
 *
 * `ComposeScreen.test.tsx` proves the global chooser has no List-item form and
 * `ListDetailScreen.test.tsx` proves the inline add row names its List. This journey proves
 * both routes reach their real writes: global Add creates one List through the ordinary
 * Blank-first catalogue, while contextual Add writes one item to the open List's path.
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

test('global Add creates a List and contextual Add creates its List item', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const groceries = `Groceries ${stamp}`;
  const quickList = `Quick list ${stamp}`;
  const title = `Try Zahav ${stamp}`;

  /**
   * The `groceries` template carries the `groceries` slot — the product's only destination
   * marker — and this list is created **first** and touched **last**, so it is both the
   * plausible default and the most recent. Neither may pre-select it.
   */
  const groceriesId = await createList(request, groceries, 'groceries');

  const requests: string[] = [];
  page.on('request', (sent) => requests.push(`${sent.method()} ${sent.url()}`));

  await page.goto('/lists');
  await expect(testId(page, 'lists-screen')).toBeVisible();

  // ---- Route one: global `+` → `Add list` ---------------------------------------
  await testId(page, 'global-add').click();
  await page.getByRole('button', { name: /^Add list,/ }).click();

  // The ordinary catalogue opens unselected; no global List-item destination exists.
  await expect(testId(page, 'list-style-chooser')).toBeVisible();
  await expect(page.getByLabel(/^List name,/)).toHaveCount(0);
  await expect(testId(page, 'list-destination-chooser')).toHaveCount(0);
  await expect(testId(page, 'compose-form')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^List item,/ })).toHaveCount(0);
  expect(requests.filter((line) => /capture/.test(line))).toEqual([]);
  await expectNoSeriousA11yViolations(page, '/compose (Add list catalogue)');

  await testId(page, 'list-style-blank').click();
  await page.getByLabel(/^List name,/).fill(quickList);
  await testId(page, 'new-list-create').click();
  await expect(testId(page, 'lists-screen')).toBeVisible();
  await expect(page.getByText(quickList)).toBeVisible();
  expect(await itemTitles(request, groceriesId)).toEqual([]);

  // ---- Route two: inline `+ Add an item` inside a List ----------------------------
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
  const field = page.getByLabel('Title');
  await expect(field).toBeVisible();
  await field.fill(title);
  await page.getByLabel('Note').fill('Buy two');
  await page.getByRole('button', { name: `Add to ${groceries}` }).click();

  // The words land in the fixed contextual destination.
  await expect(page.getByText(title)).toBeVisible();
  expect(await itemTitles(request, groceriesId)).toEqual([title]);

  // No suggestion or capture request fired on either route.
  expect(requests.filter((line) => /capture|suggest/.test(line))).toEqual([]);
});
