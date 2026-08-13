import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { agendaRow, agendaRowBodies } from '../support/agenda';
import {
  API,
  createTask,
  deleteActivities,
  e2eHeaders,
  wallDate,
  ZONE,
} from '../support/api';

test('reschedules from the time column, re-sorts, and persists the new time', async ({
  page,
  request,
}) => {
  const prefix = `P2-37 reschedule ${randomUUID()}`;
  const today = wallDate();
  const first = await createTask(request, {
    title: `${prefix} first`,
    date: today,
    time: '18:00',
  });
  const target = await createTask(request, {
    title: `${prefix} target`,
    date: today,
    time: '19:00',
  });
  const last = await createTask(request, {
    title: `${prefix} last`,
    date: today,
    time: '20:00',
  });

  try {
    await page.clock.setFixedTime(new Date(`${today}T17:00:00.000Z`));
    await page.goto('/');
    await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();
    const ownBodies = agendaRowBodies(page, prefix);
    await expect(ownBodies).toHaveCount(3);
    await expect(ownBodies).toHaveText([
      `${prefix} first`,
      `${prefix} target`,
      `${prefix} last`,
    ]);

    const row = agendaRow(page, target.activityId);
    await row.locator('[data-testid="agenda-row-time"]').click();
    await expect(page.locator('[data-testid="reschedule-sheet"]')).toBeVisible();
    await page
      .locator('[data-testid="reschedule-time-picker"]')
      .getByRole('button', { name: '7:00 PM' })
      .click();
    await page.locator('input[aria-label="Time"]').fill('20:30');
    const scheduleResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/v1/activities/${target.activityId}/schedule`,
    );
    await page.getByRole('button', { name: 'Done' }).click();
    await scheduleResponse;
    await expect(page.locator('[data-testid="reschedule-sheet"]')).toHaveCount(0);
    await expect(row.locator('[data-testid="agenda-row-time"]')).toContainText('8:30 PM');
    await expect
      .poll(() => ownBodies.allTextContents())
      .toEqual([`${prefix} first`, `${prefix} last`, `${prefix} target`]);

    const stored = await request.get(`${API}/v1/activities/${target.activityId}`, {
      headers: e2eHeaders(),
    });
    expect(stored.ok()).toBe(true);
    const body = (await stored.json()) as {
      data: { activity: { schedule?: { time?: string } } };
    };
    expect(body.data.activity.schedule?.time).toBe('20:30');
    await expectNoSeriousA11yViolations(page, '/ (reschedule closed)');
  } finally {
    await deleteActivities(request, [
      first.activityId,
      target.activityId,
      last.activityId,
    ]);
  }
});

test('an ignored passed plan disappears tomorrow without fault styling in Plans', async ({
  page,
  request,
}) => {
  const now = new Date();
  const today = wallDate(now);
  const tomorrowInstant = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const title = `P2-37 passed ${randomUUID()}`;
  const created = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      objectKind: 'plan',
      type: 'event',
      title,
      details: { kind: 'event' },
      schedule: { date: today, time: '00:00', timezone: ZONE },
    },
  });
  expect(created.ok()).toBe(true);
  const createdBody = (await created.json()) as { data: { activityId: string } };
  const activityId = createdBody.data.activityId;

  try {
    await page.clock.setFixedTime(now);
    await page.goto('/');
    const row = agendaRow(page, activityId);
    await expect(row).toContainText(title);
    await expect(
      row.getByRole('button', { name: `How did it go? Choose an outcome for ${title}` }),
    ).toBeVisible();

    await page.clock.setFixedTime(tomorrowInstant);
    await page.goto('/');
    await expect(page.locator(`[data-testid="agenda-row-${activityId}"]`)).toHaveCount(0);
    await expect(page.getByText(title)).toHaveCount(0);

    await page.goto('/plans');
    await expect(page.locator('[data-testid="plans-screen"]')).toBeVisible();
    await expect(page.getByText(/unresolved|needs attention|overdue/i)).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, '/plans');

    const stored = await request.get(`${API}/v1/activities/${activityId}`, {
      headers: e2eHeaders(),
    });
    expect(stored.ok()).toBe(true);
    const storedBody = (await stored.json()) as {
      data: { activity: { activityId: string; status: string } };
    };
    expect(storedBody.data.activity).toEqual(
      expect.objectContaining({ activityId, status: 'scheduled' }),
    );
  } finally {
    await page.clock.setFixedTime(new Date());
    await deleteActivities(request, [activityId]);
  }
});
