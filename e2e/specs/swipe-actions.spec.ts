import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('agenda rows expose hover actions and keyboard-reachable equivalents', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('[data-testid="today-agenda"]')).toBeVisible();

  const row = page
    .locator('[data-testid^="swipeable-row-"]')
    .filter({ hasText: 'Water the plants' })
    .first();
  const positive = row.locator('[data-testid="agenda-web-positive-action"]');
  const more = row.locator('[data-testid="agenda-web-more-actions"]');
  const controls = row.locator('[data-testid="agenda-web-controls"]');

  await expect(row).toBeVisible();
  await expect(controls).toHaveCSS('opacity', '0');

  await row.hover();
  await expect(controls).toHaveCSS('opacity', '1');
  await expect(positive).toHaveAccessibleName('Complete');
  await expect(more).toHaveAccessibleName('More actions for Water the plants');

  await page.mouse.move(0, 0);
  await expect(controls).toHaveCSS('opacity', '0');
  await positive.focus();
  await expect(controls).toHaveCSS('opacity', '1');

  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.locator('[data-testid="agenda-web-action-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Schedule' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeVisible();

  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations
      .filter(
        (violation) => violation.impact === 'serious' || violation.impact === 'critical',
      )
      .flatMap((violation) =>
        violation.nodes.map(
          (node) =>
            `${violation.id} (${violation.impact}) at ${node.target.join(' ')}: ` +
            `${node.failureSummary?.replace(/\s+/g, ' ').trim() ?? violation.help}`,
        ),
      ),
  ).toEqual([]);
});
