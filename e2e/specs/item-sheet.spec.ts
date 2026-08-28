import { randomBytes, randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders, wallDate, ZONE } from '../support/api';

/**
 * The item sheet against the real API (P3-29), and the one rule only an end-to-end test can
 * hold: **renaming an item renames the item** (P3-14,
 * [`plans-and-lists.md`](../../docs/01-product/plans-and-lists.md) §6.2).
 *
 * ## Why this needs a server
 *
 * `ItemSheet.test.tsx` proves the sheet sends `{ title }` and nothing else. What it cannot
 * prove is what happens on the other end of that request — and the failure mode here is a
 * *server* one: the item's title is seeded onto the Plan once, at `POST .../schedule`, and a
 * later `PATCH` that propagated would silently rewrite a Plan the user did not open. That is
 * invisible to any client test, because the client is behaving correctly in both worlds.
 *
 * So the item is renamed through the sheet, and the Plan is opened afterwards to read its
 * heading. The Plan's title never travels on the wire beside the item (§6.2), which is why the
 * assertion has to be made on the Activity screen rather than on the list.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

/** A client-minted `act_` ULID, the shape `data-model.md` §8 requires of the schedule body. */
function activityId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const random = [...randomBytes(25)].map((byte) => alphabet[byte % 32]).join('');
  return `act_0${random}`;
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

async function createItem(
  request: APIRequestContext,
  listId: string,
  title: string,
): Promise<string> {
  const response = await request.post(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(randomUUID()),
    data: { title },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { data: { itemId: string } };
  return body.data.itemId;
}

/**
 * `Plan this item`, as the API sees it.
 *
 * Driven through the API rather than the UI because that flow's sheet is P3-33's and is
 * deliberately absent from this build. Every explicit choice the route requires is supplied
 * here — the Plan kind and the audience — because the client is forbidden from defaulting
 * either, and a helper that filled them in would be modelling the bug.
 */
async function planItem(
  request: APIRequestContext,
  listId: string,
  itemId: string,
  date: string,
): Promise<{ activityId: string; title: string }> {
  const id = activityId();
  const response = await request.post(
    `${API}/v1/lists/${listId}/items/${itemId}/schedule`,
    {
      headers: e2eHeaders(randomUUID()),
      data: {
        activityId: id,
        creationTarget: { objectKind: 'plan', type: 'general' },
        audience: { mode: 'just_me' },
        schedule: { date, time: '19:00', timezone: ZONE },
      },
    },
  );
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as {
    data: { activity: { activityId: string; title: string } };
  };
  return body.data.activity;
}

async function readItem(
  request: APIRequestContext,
  listId: string,
  itemId: string,
): Promise<{ title: string; note?: string }> {
  const response = await request.get(`${API}/v1/lists/${listId}/items/${itemId}`, {
    headers: e2eHeaders(),
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { data: { title: string; note?: string } };
  return body.data;
}

test('renaming a linked item leaves its Plan title alone', async ({ page, request }) => {
  const stamp = Date.now();
  const listId = await createList(
    request,
    `Restaurants to try ${stamp}`,
    'restaurants-to-try',
  );
  const original = `Zahav ${stamp}`;
  const renamed = `Zahav (Old City) ${stamp}`;
  const itemId = await createItem(request, listId, original);
  const plan = await planItem(request, listId, itemId, wallDate());

  // The one-time seed: the Plan was born with the item's title (§6.1).
  expect(plan.title).toBe(original);

  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();

  // U1: the row body opens the sheet. It does not mutate anything (CLAUDE.md rule 6).
  await testId(page, `list-item-${itemId}-body`).click();
  await expect(testId(page, 'item-sheet')).toBeVisible();

  const title = testId(page, 'item-sheet-title');
  await expect(title).toHaveValue(original);
  await title.fill(renamed);
  // One PATCH per field, on blur. No Save button exists to press.
  await title.blur();

  await expect
    .poll(async () => (await readItem(request, listId, itemId)).title)
    .toBe(renamed);

  // The note is its own field and its own write; renaming did not touch it.
  const note = testId(page, 'item-sheet-note');
  await note.fill('Ask for the counter');
  await note.blur();
  await expect
    .poll(async () => (await readItem(request, listId, itemId)).note)
    .toBe('Ask for the counter');

  // ---- Open the Plan the item is linked to --------------------------------------
  await page.goto(`/activity/${plan.activityId}`);
  await expect(page.getByRole('heading', { name: original })).toBeVisible();
  await expect(page.getByText(renamed)).toHaveCount(0);
});

test('deleting an item asks nothing and deletes immediately', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const listId = await createList(request, `Groceries ${stamp}`, 'groceries');
  const title = `Tortillas ${stamp}`;
  const itemId = await createItem(request, listId, title);

  await page.goto(`/lists/${listId}`);
  await testId(page, `list-item-${itemId}-body`).click();
  await expect(testId(page, 'item-sheet')).toBeVisible();

  await testId(page, 'item-sheet-delete').click();

  // §4.1: no confirmation. The dialog component is never mounted, and neither is its accept.
  await expect(testId(page, 'confirm-dialog')).toHaveCount(0);
  await expect(testId(page, 'confirm-accept')).toHaveCount(0);
  // The request went on the tap, not at the end of the window (P2-24).
  await expect
    .poll(async () => {
      const response = await request.get(`${API}/v1/lists/${listId}/items/${itemId}`, {
        headers: e2eHeaders(),
      });
      return response.status();
    })
    .toBe(404);
  await expect(page.getByText(`${title} deleted`)).toBeVisible();
});

test('undo inside the offer window restores the same item', async ({ page, request }) => {
  const stamp = Date.now();
  const listId = await createList(request, `Groceries ${stamp}`, 'groceries');
  const title = `Tortillas ${stamp}`;
  const itemId = await createItem(request, listId, title);

  await page.goto(`/lists/${listId}`);
  await testId(page, `list-item-${itemId}-body`).click();
  await testId(page, 'item-sheet-delete').click();

  // Inside the six seconds, and with nothing polled in between that could spend them.
  await testId(page, 'toast-action').click();

  /*
   * The **same** id, restored server-side (§P3-10): the client never re-created a row, so a
   * fresh `itm_` here would be the failure this asserts against.
   */
  await expect
    .poll(async () => (await readItem(request, listId, itemId)).title)
    .toBe(title);
  await expect(page.getByText(title)).toBeVisible();
});
