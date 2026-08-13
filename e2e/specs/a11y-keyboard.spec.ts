import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { agendaRow, agendaRowBodies } from '../support/agenda';
import { createTask, deleteActivities, wallDate } from '../support/api';

test('navigates and operates Today without a pointer', async ({ page, request }) => {
  const prefix = `P2-37 keyboard ${randomUUID()}`;
  const today = wallDate();
  const first = await createTask(request, {
    title: `${prefix} first`,
    date: today,
    time: '23:55',
  });
  const second = await createTask(request, {
    title: `${prefix} second`,
    date: today,
    time: '23:55',
  });

  try {
    await page.goto('/plans');
    await expect(page.locator('[data-testid="plans-screen"]')).toBeVisible();
    await page.keyboard.press('t');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();

    const ownBodies = agendaRowBodies(page, prefix);
    await expect(ownBodies).toHaveCount(2);
    const firstBody = agendaRow(page, first.activityId).locator(
      '[data-testid="agenda-row-body"]',
    );
    const secondBody = agendaRow(page, second.activityId).locator(
      '[data-testid="agenda-row-body"]',
    );

    await firstBody.focus();
    const firstRow = firstBody.locator(
      'xpath=ancestor::*[@data-testid][starts-with(@data-testid, "swipeable-row-")]',
    );
    const time = firstRow.locator('[data-testid="agenda-row-time"]');
    const positive = firstRow.locator('[data-testid="agenda-web-positive-action"]');
    const more = firstRow.locator('[data-testid="agenda-web-more-actions"]');
    await expect(firstRow.locator('[data-testid="agenda-web-controls"]')).toHaveCSS(
      'opacity',
      '1',
    );
    await page.keyboard.press('Tab');
    await expect(time).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(positive).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(more).toBeFocused();

    await firstBody.focus();
    await page.keyboard.press('ArrowDown');
    await expect(secondBody).toBeFocused();

    const completeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/activities/${second.activityId}/complete`,
    );
    await page.keyboard.press('Space');
    await completeResponse;
    await expect(page.getByRole('alert')).toContainText('Task completed');

    await firstBody.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/activity\/act_/);
    await expect(page.locator('[data-testid="detail-title"]')).toBeVisible();
    await expectNoSeriousA11yViolations(page, '/activity/:id');
  } finally {
    await deleteActivities(request, [first.activityId, second.activityId]);
  }
});
