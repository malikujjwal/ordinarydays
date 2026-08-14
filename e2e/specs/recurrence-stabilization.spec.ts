import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { agendaRow } from '../support/agenda';
import { createDailyTask, deleteActivities, wallDate } from '../support/api';

test('keeps occurrence actions scoped while a daily series becomes a one-off', async ({
  page,
  request,
}) => {
  const now = new Date();
  const today = wallDate(now);
  const tomorrowInstant = new Date(`${today}T12:00:00.000Z`);
  tomorrowInstant.setUTCDate(tomorrowInstant.getUTCDate() + 1);
  const tomorrow = tomorrowInstant.toISOString().slice(0, 10);
  const title = `P2-55 recurrence ${randomUUID()}`;
  const series = await createDailyTask(request, { title, date: today, time: '18:00' });

  try {
    await page.clock.setFixedTime(now);
    await page.goto('/');
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();
    const todayRow = agendaRow(page, series.activityId).filter({ hasText: title });
    await expect(
      todayRow.locator('[data-testid="agenda-badge-recurrence"]'),
    ).toHaveAccessibleName('Daily');

    await page.goto('/plans');
    const todayCard = page.locator(
      `[data-testid="plans-card-${series.activityId}:${today}"]`,
    );
    await expect(todayCard).toBeVisible();
    await expect(
      todayCard.getByRole('checkbox', { name: `${title}, not completed` }),
    ).toBeEnabled();
    await todayCard.locator('[data-testid="agenda-row-body"]').click();
    await expect(page).toHaveURL(
      new RegExp(`/activity/${series.activityId}\\?occurrenceDate=${today}$`),
    );
    await expect(page.locator('[data-testid="detail-complete"]')).toBeVisible();

    const completeResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/activities/${series.activityId}/complete`,
    );
    await page.locator('[data-testid="detail-complete"]').click();
    const completion = await completeResponse;
    expect(completion.ok()).toBe(true);
    expect(completion.request().postDataJSON()).toMatchObject({ occurrenceDate: today });
    await expect(page.locator('[data-testid="detail-undo"]')).toBeVisible();

    await page.goto('/plans');
    const futureCard = page.locator(
      `[data-testid="plans-card-${series.activityId}:${tomorrow}"]`,
    );
    await expect(futureCard).toBeVisible();
    await expect(
      futureCard.getByRole('checkbox', { name: `${title}, not completed` }),
    ).toBeDisabled();

    await page.clock.setFixedTime(new Date(`${tomorrow}T16:00:00.000Z`));
    await page.goto('/');
    const tomorrowRow = agendaRow(page, series.activityId).filter({ hasText: title });
    await expect(tomorrowRow.getByRole('checkbox')).not.toBeChecked();
    await expect(tomorrowRow.getByRole('checkbox')).toBeEnabled();

    await tomorrowRow.locator('[data-testid="agenda-row-time"]').click();
    await expect(page.locator('[data-testid="reschedule-sheet"]')).toBeVisible();
    await page.getByRole('button', { name: 'This occurrence only' }).click();
    await page
      .locator('[data-testid="reschedule-time-picker"]')
      .getByRole('button', { name: '6:00 PM' })
      .click();
    await page.locator('input[aria-label="Time"]').fill('19:30');
    const scheduleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/activities/${series.activityId}/schedule`,
    );
    await page
      .locator('[data-testid="reschedule-time-picker"]')
      .getByRole('button', { name: 'Done' })
      .click();
    await scheduleResponse;
    await expect(tomorrowRow.locator('[data-testid="agenda-row-time"]')).toContainText(
      '7:30 PM',
    );

    await tomorrowRow.locator('[data-testid="agenda-row-body"]').click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(title);
    await page.locator('[data-testid="detail-edit-recurrence"]').click();
    await page.locator('[data-testid="repeat-option"]').selectOption('weekly');
    const patchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/v1/activities/${series.activityId}`,
    );
    await page.getByRole('button', { name: 'Apply repeat' }).click();
    await patchResponse;
    await expect(page.locator('[data-testid="detail-edit-recurrence"]')).toContainText(
      'Weekly on',
    );

    await page.locator('[data-testid="detail-edit-recurrence"]').click();
    await page.locator('[data-testid="repeat-option"]').selectOption('never');
    await page.getByRole('button', { name: 'Apply repeat' }).click();
    await expect(
      page.locator('[data-testid="repeat-convert-confirmation"]'),
    ).toBeVisible();
    const convertResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/activities/${series.activityId}/recurrence/convert`,
    );
    await page.getByRole('button', { name: 'Make this a one-off' }).click();
    await convertResponse;
    await expect(page.locator('[data-testid="detail-edit-recurrence"]')).toContainText(
      'Does not repeat',
    );
  } finally {
    await page.clock.setFixedTime(new Date());
    await deleteActivities(request, [series.activityId]);
  }
});

test('ends a series inclusively and No end restarts it', async ({ page, request }) => {
  const now = new Date();
  const today = wallDate(now);
  const title = `P2-55 end restart ${randomUUID()}`;
  const series = await createDailyTask(request, { title, date: today, time: '20:00' });

  try {
    await page.clock.setFixedTime(now);
    await page.goto('/');
    const row = agendaRow(page, series.activityId).filter({ hasText: title });
    await row.locator('[data-testid="agenda-row-body"]').click();
    await expect(page.getByRole('textbox', { name: 'Title' })).toHaveValue(title);

    await page.locator('[data-testid="detail-edit-recurrence"]').click();
    const endResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/v1/activities/${series.activityId}`,
    );
    await page.getByRole('button', { name: 'End series' }).click();
    await endResponse;
    await expect(page.locator('[data-testid="detail-edit-recurrence"]')).toContainText(
      'until',
    );

    await page.locator('[data-testid="detail-edit-recurrence"]').click();
    await page.locator('[data-testid="repeat-ends"]').selectOption('never');
    const restartResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `/v1/activities/${series.activityId}`,
    );
    await page.getByRole('button', { name: 'Apply repeat' }).click();
    await restartResponse;
    const repeat = page.locator('[data-testid="detail-edit-recurrence"]');
    await expect(repeat).toContainText('Daily');
    await expect(repeat).not.toContainText('until');
  } finally {
    await page.clock.setFixedTime(new Date());
    await deleteActivities(request, [series.activityId]);
  }
});
