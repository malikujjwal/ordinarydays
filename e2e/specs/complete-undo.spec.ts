import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { agendaRow, agendaRowBodies, openEarlierToday } from '../support/agenda';
import { createTask, deleteActivities, wallDate } from '../support/api';

test('creates, completes, and compensates a task without changing its prior position', async ({
  page,
  request,
}) => {
  const prefix = `P2-37 complete ${randomUUID()}`;
  const today = wallDate();
  const createdIds: string[] = [];
  const first = await createTask(request, { title: `${prefix} first`, date: today });
  const last = await createTask(request, { title: `${prefix} last`, date: today });
  createdIds.push(first.activityId, last.activityId);

  try {
    const agendaRequests: string[] = [];
    page.on('request', (requestEvent) => {
      if (new URL(requestEvent.url()).pathname === '/v1/agenda') {
        agendaRequests.push(requestEvent.url());
      }
    });

    const agendaResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/v1/agenda',
    );
    await page.goto('/');
    await agendaResponse;
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();
    /**
     * Acceptance criterion 6 / S2. **The count of one is what this protects** — "a second
     * request creeps into Today's cold open" is the failure it was written against, and that has
     * not moved.
     *
     * The window is now two days (P2-45): the four Today sections still partition `days[0]`
     * alone, and `days[1]` feeds the read-only Tomorrow preview out of this same response rather
     * than a second query. Asserted as *exactly* one day apart so widening it further would fail
     * here, which is the part worth pinning.
     */
    expect(agendaRequests).toHaveLength(1);
    const coldOpen = new URL(agendaRequests[0] ?? '');
    const from = coldOpen.searchParams.get('from') ?? '';
    const to = coldOpen.searchParams.get('to') ?? '';
    const dayAfter = new Date(`${from}T00:00:00.000Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect(to).toBe(dayAfter.toISOString().slice(0, 10));
    expect(coldOpen.searchParams.get('include')).toBe('anytime_unscheduled,overdue');
    await expectNoSeriousA11yViolations(page, '/');

    const targetTitle = `${prefix} target`;
    await page.locator('[data-testid="today-add-task"]').click();
    await expect(page.locator('[data-testid="compose-form"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save task' })).toBeVisible();
    await page.locator('[data-testid="compose-title"]').fill(targetTitle);
    await expectNoSeriousA11yViolations(page, '/compose');

    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/activities',
    );
    await page.getByRole('button', { name: 'Save task' }).click();
    const created = (await (await createResponse).json()) as {
      data: { activityId: string };
    };
    createdIds.push(created.data.activityId);
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();

    const ownBodies = agendaRowBodies(page, prefix);
    await expect(ownBodies).toHaveCount(3);
    const priorOrder = await ownBodies.allTextContents();
    const targetRow = agendaRow(page, created.data.activityId).filter({
      hasText: targetTitle,
    });

    const networkLog: string[] = [];
    page.on('request', (requestEvent) => {
      const path = new URL(requestEvent.url()).pathname;
      if (path.endsWith('/complete')) networkLog.push('complete');
      if (path.endsWith('/uncomplete')) networkLog.push('uncomplete');
    });
    const completeResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/complete'),
    );
    await targetRow.getByRole('checkbox').click();
    await expect(page.getByRole('alert')).toContainText('Task completed');
    networkLog.push('toast');
    expect(networkLog.slice(0, 2)).toEqual(['complete', 'toast']);
    await completeResponse;

    const uncompleteResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/uncomplete'),
    );
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    await uncompleteResponse;
    expect(networkLog).toContain('uncomplete');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => ownBodies.allTextContents()).toEqual(priorOrder);
  } finally {
    await deleteActivities(request, createdIds);
  }
});

test('completing from detail crosses the Today task off before the request settles', async ({
  page,
  request,
}) => {
  const title = `P2-41 detail complete ${randomUUID()}`;
  const created = await createTask(request, { title, date: wallDate() });
  let releaseComplete = () => {};
  const heldComplete = new Promise<void>((resolve) => {
    releaseComplete = resolve;
  });

  await page.route('**/v1/activities/*/complete', async (route) => {
    await heldComplete;
    await route.continue();
  });

  try {
    await page.goto('/');
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();
    const row = agendaRow(page, created.activityId).filter({ hasText: title });
    await row.locator('[data-testid="agenda-row-body"]').click();
    await expect(page.locator('[data-testid="detail-complete"]')).toBeVisible();

    const completionStarted = page.waitForRequest((requestEvent) =>
      new URL(requestEvent.url()).pathname.endsWith('/complete'),
    );
    await page.locator('[data-testid="detail-complete"]').click();
    await completionStarted;
    await page.locator('[data-testid="detail-back"]').click();

    /**
     * The task is untimed, so completing it moves it out of ANYTIME to EARLIER TODAY — the one
     * relocation that still happens (`today-and-tasks.md` §2.2, amended 2026-08-17) — and that
     * section is collapsed by default (§2.4).
     */
    await openEarlierToday(page);
    const projected = agendaRow(page, created.activityId).filter({ hasText: title });
    await expect(projected.getByRole('checkbox')).toBeChecked();
    await expect(projected.getByText(title, { exact: true })).toHaveCSS(
      'text-decoration-line',
      'line-through',
    );

    const completionFinished = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/complete'),
    );
    releaseComplete();
    await completionFinished;
  } finally {
    releaseComplete();
    await page.unroute('**/v1/activities/*/complete');
    await deleteActivities(request, [created.activityId]);
  }
});
