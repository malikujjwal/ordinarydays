import { randomBytes, randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders, wallDate, ZONE } from '../support/api';

/**
 * The `Plan this item` kind-and-audience sheet, end to end (P3-34,
 * [`plans-and-lists.md`](../../docs/01-product/plans-and-lists.md) §6).
 *
 * The task's own required flow: open `Plan this item` on `Severance`, assert all four kinds
 * and no selection, choose `Watch`, assert the form stays closed until `Just me` is visibly
 * tapped, edit the offered S2 E5 to S2 E6, confirm, and assert the request carried
 * `creationTarget.type: 'watch'` and `audience.mode: 'just_me'`. Then the counter-proof: the
 * same entry point on the same Watch Later-configured list, choosing `General`, stores
 * `custom` — neither the creation type nor the resolved List configuration chooses the kind.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

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

/** Severance, part-watched: episode Progress S2 E4 and intrinsic state `active`. */
async function createWatchingItem(
  request: APIRequestContext,
  listId: string,
  title: string,
): Promise<string> {
  const created = await request.post(`${API}/v1/lists/${listId}/items`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      title,
      features: {
        progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const body = (await created.json()) as { data: { itemId: string } };
  const activated = await request.patch(
    `${API}/v1/lists/${listId}/items/${body.data.itemId}`,
    { headers: e2eHeaders(), data: { state: 'active' } },
  );
  expect(activated.ok(), await activated.text()).toBe(true);
  return body.data.itemId;
}

async function openPlanThisItem(page: Page, listId: string, itemId: string) {
  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();
  await testId(page, `list-item-${itemId}-body`).click();
  await expect(testId(page, 'item-sheet')).toBeVisible();
  await testId(page, 'item-sheet-plan').click();
}

function captureScheduleBody(page: Page, listId: string, itemId: string): unknown[] {
  const url = `${API}/v1/lists/${listId}/items/${itemId}/schedule`;
  const bodies: unknown[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url() === url) {
      bodies.push(sent.postDataJSON());
    }
  });
  return bodies;
}

test('Watch is an explicit choice, the audience is a required tap, and S2 E5 is editable', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const listId = await createList(request, `Watchlist ${stamp}`, 'watch-later');
  const itemId = await createWatchingItem(request, listId, `Severance ${stamp}`);
  const bodies = captureScheduleBody(page, listId, itemId);

  await openPlanThisItem(page, listId, itemId);

  // Step one: all four kinds, nothing selected, no Plan form field anywhere.
  await expect(page.getByRole('heading', { name: 'What kind of plan?' })).toBeVisible();
  for (const kind of ['General', 'Meal', 'Watch', 'Event']) {
    await expect(
      page.getByRole('button', { name: new RegExp(`^${kind},`) }),
    ).toBeVisible();
  }
  await expect(page.getByRole('textbox', { name: 'Movie or show' })).toHaveCount(0);

  await page.getByRole('button', { name: /^Watch,/ }).click();

  // Step two: the required audience. The form has not opened and nothing was written.
  await expect(
    page.getByRole('heading', { name: 'Who is this plan for?' }),
  ).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Movie or show' })).toHaveCount(0);
  expect(bodies).toHaveLength(0);

  await page.getByRole('button', { name: /^Just me,/ }).click();

  // Step three: the Watch form, pre-filled with the item's title and the offered next
  // episode — the item is `active` at S2 E4, so the offer is S2 E5, and it stays editable.
  await expect(page.getByRole('textbox', { name: 'Movie or show' })).toHaveValue(
    `Severance ${stamp}`,
  );
  const episode = page.getByRole('textbox', { name: 'Episode' });
  await expect(episode).toHaveValue('5');
  await episode.fill('6');

  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('Watch plan · saved to Needs a date')).toBeVisible();

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    creationTarget: { objectKind: 'plan', type: 'watch' },
    audience: { mode: 'just_me' },
    details: { kind: 'watch', season: 2, episode: 6 },
  });
});

test('General on a Watch Later list stores custom — configuration never chooses the kind', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const listId = await createList(request, `Watchlist ${stamp}`, 'watch-later');
  const itemId = await createWatchingItem(request, listId, `Severance ${stamp}`);
  const bodies = captureScheduleBody(page, listId, itemId);

  await openPlanThisItem(page, listId, itemId);
  await page.getByRole('button', { name: /^General,/ }).click();
  await page.getByRole('button', { name: /^Just me,/ }).click();

  // A General form: no episode fields exist for the offer to have leaked into.
  await expect(page.getByRole('textbox', { name: 'Episode' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save plan' }).click();
  await expect(page.getByText('General plan · saved to Needs a date')).toBeVisible();

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    creationTarget: { objectKind: 'plan', type: 'custom' },
    audience: { mode: 'just_me' },
  });
  expect(bodies[0]).not.toHaveProperty('details.season');
});

/**
 * The caller-scoped Plan state line's two tap targets (P3-35, §6.2): the state line opens the
 * linked Activity, the title opens the item sheet, and neither reaches the other's screen.
 */
test('the state line opens the Plan and the title opens the item sheet', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const listId = await createList(request, `Watchlist ${stamp}`, 'watch-later');
  const itemId = await createWatchingItem(request, listId, `Severance ${stamp}`);

  // Two days out is inside the 7-day window, so the line carries the weekday name.
  const scheduledFor = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const date = wallDate(scheduledFor);
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    weekday: 'long',
  }).format(scheduledFor);

  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const activityId = `act_0${[...randomBytes(25)].map((b) => alphabet[b % 32]).join('')}`;
  const scheduled = await request.post(
    `${API}/v1/lists/${listId}/items/${itemId}/schedule`,
    {
      headers: e2eHeaders(randomUUID()),
      data: {
        activityId,
        creationTarget: { objectKind: 'plan', type: 'watch' },
        audience: { mode: 'just_me' },
        schedule: { date, time: '20:00', timezone: ZONE },
      },
    },
  );
  expect(scheduled.ok(), await scheduled.text()).toBe(true);

  await page.goto(`/lists/${listId}`);
  await expect(testId(page, 'list-detail')).toBeVisible();

  const line = testId(page, `list-item-${itemId}-plan-state`);
  await expect(line).toHaveText(`Next session ${weekday} · 8 PM`);
  await expect(
    page.getByRole('link', { name: `Next session ${weekday} 8:00 PM, open plan` }),
  ).toBeVisible();

  // The state line opens the **Activity**, not the item detail (§6.2).
  await line.click();
  await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(
    `Severance ${stamp}`,
  );
  await expect(testId(page, 'item-sheet')).toHaveCount(0);

  // The title opens the item sheet, not the Plan.
  await page.goBack();
  await expect(testId(page, 'list-detail')).toBeVisible();
  await testId(page, `list-item-${itemId}-body`).click();
  await expect(testId(page, 'item-sheet')).toBeVisible();
});
