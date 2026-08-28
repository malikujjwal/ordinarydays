import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders } from '../support/api';

/**
 * Dragging a list item, against the real API (P3-30, acceptance criterion 16).
 *
 * ## What only an end-to-end test can prove here
 *
 * `reorder.test.ts` proves the plan and `useReorderItems.test.tsx` proves the request, both
 * against a spy. What neither can prove is that the request **means** what the client thinks:
 * `afterItemId` is `nullable().optional()` on the wire, `null` moves a row to the front and an
 * absent field is no reorder at all, and a client that omitted it for the head would pass every
 * unit test while moving nothing. That distinction only exists on the server.
 *
 * The keyboard grab drives it, because §7.1's pointer drag has no keyboard-free equivalent and
 * the grab is a required path in its own right — §7.1 ends with "hover-revealed controls are
 * always **also** reachable by keyboard and are never the only path to an action".
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

async function createList(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post(`${API}/v1/lists`, {
    headers: e2eHeaders(randomUUID()),
    data: { title, templateKey: 'groceries' },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { listId: string } }).data.listId;
}

async function addItem(
  request: APIRequestContext,
  listId: string,
  title: string,
): Promise<string> {
  const response = await request.post(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(randomUUID()),
    data: { title },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { data: { itemId: string } }).data.itemId;
}

/** The server's own order, which is `(rank, itemId)` and the only authority on it. */
async function storedTitles(
  request: APIRequestContext,
  listId: string,
): Promise<string[]> {
  const response = await request.get(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(),
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { data: { item: { title: string } }[] };
  return body.data.map((entry) => entry.item.title);
}

/** Grab, move, drop — one drag, whatever the number of keypresses. */
async function drag(page: Page, itemId: string, steps: number): Promise<void> {
  const handle = testId(page, `list-reorder-handle-${itemId}`);
  await handle.focus();
  await page.keyboard.press('Enter');
  for (let at = 0; at < Math.abs(steps); at += 1) {
    await page.keyboard.press(steps > 0 ? 'ArrowDown' : 'ArrowUp');
  }
  await page.keyboard.press('Enter');
}

test('a drag moves one item, and moving to the head actually moves it', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const listId = await createList(request, `Groceries ${stamp}`);
  const first = `Milk ${stamp}`;
  const second = `Eggs ${stamp}`;
  const third = `Bread ${stamp}`;
  await addItem(request, listId, first);
  await addItem(request, listId, second);
  const thirdId = await addItem(request, listId, third);

  expect(await storedTitles(request, listId)).toEqual([first, second, third]);

  const requests: string[] = [];
  page.on('request', (sent) => requests.push(`${sent.method()} ${sent.url()}`));

  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();
  await expect(page.getByText(third)).toBeVisible();

  // ---- The head: the case an absent `afterItemId` would silently no-op ----------
  await drag(page, thirdId, -2);

  await expect
    .poll(async () => await storedTitles(request, listId))
    .toEqual([third, first, second]);

  // Exactly one write for the whole drag, and it is a PATCH of that one item.
  const writes = requests.filter(
    (line) => !line.startsWith('GET ') && line.includes('/v1/'),
  );
  expect(writes).toEqual([`PATCH ${API}/v1/lists/${listId}/items/${thirdId}`]);

  // ---- Back down, to prove the id form travels too ------------------------------
  await drag(page, thirdId, 2);

  await expect
    .poll(async () => await storedTitles(request, listId))
    .toEqual([first, second, third]);
});

test('a drop back where it started writes nothing', async ({ page, request }) => {
  const stamp = Date.now();
  const listId = await createList(request, `Groceries ${stamp}`);
  await addItem(request, listId, `Milk ${stamp}`);
  const eggsId = await addItem(request, listId, `Eggs ${stamp}`);

  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();

  const requests: string[] = [];
  page.on('request', (sent) => requests.push(`${sent.method()} ${sent.url()}`));

  // Grabbed and dropped without moving, and cancelled after moving. Neither is a write.
  await drag(page, eggsId, 0);
  const handle = testId(page, `list-reorder-handle-${eggsId}`);
  await handle.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');

  expect(requests.filter((line) => line.startsWith('PATCH'))).toEqual([]);
  expect(await storedTitles(request, listId)).toEqual([`Milk ${stamp}`, `Eggs ${stamp}`]);
});
