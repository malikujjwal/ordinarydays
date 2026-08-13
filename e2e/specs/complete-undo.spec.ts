import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { agendaRow, agendaRowBodies } from '../support/agenda';
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
    expect(agendaRequests).toHaveLength(1);
    const coldOpen = new URL(agendaRequests[0] ?? '');
    expect(coldOpen.searchParams.get('from')).toBe(coldOpen.searchParams.get('to'));
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
