import { expect, test } from '@playwright/test';

test('Cmd+Z restores a completed task to its exact prior position', async ({ page }) => {
  await page.goto('/');
  const agenda = page.locator('[data-testid="today-agenda"]');
  await expect(agenda).toBeVisible();

  const row = page
    .locator('[data-testid^="agenda-row-act_"]')
    .filter({ hasText: 'Return the library books' })
    .first();
  await expect(row).toBeVisible();
  const rows = agenda.locator('[data-testid^="agenda-row-act_"]');
  const before = await rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-testid')),
  );
  const scrollBefore = await agenda.evaluate((element) => element.scrollTop);

  await row.getByRole('checkbox').click();
  await expect(page.getByRole('alert')).toContainText('Task completed');
  await page.keyboard.press('Meta+z');

  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(() =>
      rows.evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-testid')),
      ),
    )
    .toEqual(before);
  await expect
    .poll(() => agenda.evaluate((element) => element.scrollTop))
    .toBe(scrollBefore);
});
