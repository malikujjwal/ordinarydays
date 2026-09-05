import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { agendaRow } from '../support/agenda';
import { API, createTask, deleteActivities, e2eHeaders, wallDate } from '../support/api';

for (const scheme of ['light', 'dark'] as const) {
  test(`Activity notes draft, save, discard and return (${scheme}, small screen)`, async ({
    page,
    request,
  }, testInfo) => {
    const activity = await createTask(request, {
      title: `Notes ${randomUUID()}: Sunday dinner with Maya and Jordan and our visiting friends`,
      date: wallDate(),
    });
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    try {
      await page.goto('/');
      const row = agendaRow(page, activity.activityId).getByTestId('agenda-row-body');
      await row.focus();
      await page.keyboard.press('Enter');
      const title = page.getByRole('textbox', { name: 'Title' });
      await expect(title).toHaveValue(activity.title);
      const expanded = await title.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      await title.fill('Short title');
      await expect
        .poll(() => title.evaluate((element) => element.getBoundingClientRect().height))
        .toBeLessThan(expanded);
      await title.fill(activity.title);
      await expect
        .poll(() => title.evaluate((element) => element.getBoundingClientRect().height))
        .toBeGreaterThan(expanded / 2);
      const edit = page.getByRole('button', { name: 'Add notes', exact: true });
      await edit.click();
      const field = page.getByRole('textbox', { name: 'Notes for this task' });
      await expect(field).toBeFocused();
      await field.fill('Maya is bringing dessert.\nKeep the dressing on the side.');
      await page.getByText('Notes', { exact: true }).click();
      await expect(field).toHaveValue(
        'Maya is bringing dessert.\nKeep the dressing on the side.',
      );
      const unsaved = await request.get(`${API}/v1/activities/${activity.activityId}`, {
        headers: e2eHeaders(),
      });
      expect((await unsaved.json()).data.activity.notes ?? '').toBe('');
      await page.screenshot({
        path: testInfo.outputPath(`notes-editor-${scheme}.png`),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Save notes', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Edit notes', exact: true }),
      ).toBeFocused();
      await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
      await expect(field).toHaveValue(
        'Maya is bringing dessert.\nKeep the dressing on the side.',
      );
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(field).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Edit notes', exact: true }),
      ).toBeFocused();
      await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
      await field.fill('A draft to keep');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(field).toHaveValue('A draft to keep');
      await expect(field).toBeFocused();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Edit notes', exact: true }),
      ).toBeFocused();
      await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
      await field.fill('A draft to leave');
      await page.getByRole('button', { name: 'Back', exact: true }).click();
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(page).not.toHaveURL(new RegExp(activity.activityId));
      await page.goto(`/activity/${activity.activityId}`);
      await expect(page.getByTestId('notes-preview')).toContainText(
        'Maya is bringing dessert.',
      );
      await page.screenshot({
        path: testInfo.outputPath(`details-${scheme}.png`),
        fullPage: true,
      });
      await expectNoSeriousA11yViolations(page, 'Activity notes');
    } finally {
      await deleteActivities(request, [activity.activityId]);
    }
  });
}

test('slow failed notes save retains the draft, prevents duplicate writes and retries', async ({
  page,
  request,
}) => {
  const activity = await createTask(request, {
    title: `Notes failure ${randomUUID()}`,
    date: wallDate(),
  });
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route(`**/v1/activities/${activity.activityId}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    writes += 1;
    if (writes !== 1) return route.continue();
    await waiting;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: {
          code: 'internal_error',
          message: 'Test save failure',
          requestId: 'req_notes_test',
        },
      }),
    });
  });
  try {
    await page.goto(`/activity/${activity.activityId}`);
    await page.getByRole('button', { name: 'Add notes', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Notes for this task' });
    await field.fill('Retain this draft');
    await page.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(page.getByTestId('notes-save')).toBeDisabled();
    await expect(page.getByTestId('notes-cancel')).toBeDisabled();
    await page.getByTestId('notes-save').dispatchEvent('click');
    expect(writes).toBe(1);
    release();
    await expect(page.getByTestId('notes-save')).toBeEnabled();
    await expect(field).toHaveValue('Retain this draft');
    await expect(field).toBeFocused();
    await expect(page.getByText(/Couldn't save your notes/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Save notes', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Edit notes', exact: true }),
    ).toBeVisible();
    expect(writes).toBe(2);
    const saved = await request.get(`${API}/v1/activities/${activity.activityId}`, {
      headers: e2eHeaders(),
    });
    expect((await saved.json()).data.activity.notes).toBe('Retain this draft');
  } finally {
    release();
    await deleteActivities(request, [activity.activityId]);
  }
});
