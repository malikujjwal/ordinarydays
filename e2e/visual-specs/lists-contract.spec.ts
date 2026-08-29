import { expect, type Page, test } from '@playwright/test';

async function openFrame(
  page: Page,
  frame: 'create' | 'settings' | 'stages' | 'items' | 'overview',
  scheme: 'light' | 'dark' = 'light',
) {
  await page.goto(
    `/lists-contract-gallery?contract=p3-33&frame=${frame}&scheme=${scheme}`,
  );
  await page.evaluate(async () => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
}

test.describe('P3-33 production List contracts', () => {
  for (const { width, gutter } of [
    { width: 320, gutter: 16 },
    { width: 768, gutter: undefined },
    { width: 1200, gutter: undefined },
  ]) {
    test(`list cards remain two-up without clipping at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openFrame(page, 'overview');

      const first = page.getByRole('button', { name: /^Untitled list\./ });
      const second = page.getByRole('button', { name: /^Checklist\./ });
      const heading = page.getByText('Lists contract gallery');
      await expect(first).toBeVisible();
      await expect(second).toBeVisible();

      const [firstBox, secondBox, headingBox] = await Promise.all([
        first.boundingBox(),
        second.boundingBox(),
        heading.boundingBox(),
      ]);
      expect(firstBox).not.toBeNull();
      expect(secondBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      if (firstBox === null || secondBox === null || headingBox === null) return;

      expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThan(1);
      expect(Math.abs(firstBox.width - secondBox.width)).toBeLessThan(1);
      expect(secondBox.x - (firstBox.x + firstBox.width)).toBeCloseTo(12, 0);
      expect(firstBox.x).toBeCloseTo(headingBox.x, 0);
      if (gutter !== undefined) expect(firstBox.x).toBeCloseTo(gutter, 0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    });
  }

  test('creation chooser is explicit and unselected', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'create');
    await expect(page.getByTestId('new-list-sheet')).toBeVisible();
    await expect(page.getByTestId('new-list-title-step')).toHaveCount(0);
    await expect(page).toHaveScreenshot('create-compact-light.png');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`settings compact ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'settings', scheme);
      await expect(page.getByTestId('list-settings')).toBeVisible();
      await expect(page.getByRole('tab', { name: 'Stages' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(page).toHaveScreenshot(`settings-compact-${scheme}.png`);
    });
  }

  test('settings expanded uses the shared centred-sheet geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFrame(page, 'settings');
    await expect(page.getByTestId('list-settings')).toBeVisible();
    await expect(page).toHaveScreenshot('settings-expanded-light.png');
  });

  test('generic stages hide no populated group and keep configured labels', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'stages');
    await expect(page.getByTestId('list-state-sections')).toBeVisible();
    await expect(page.getByText('Queued').first()).toBeVisible();
    await expect(page.getByText('Building').first()).toBeVisible();
    await expect(page.getByText('Shipped').first()).toBeVisible();
    await expect(page).toHaveScreenshot('stages-compact-light.png');
  });

  test('typed summaries stay populated-only and concise', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'items');
    await expect(page.getByText('S2 E4')).toBeVisible();
    await expect(page.getByText('Page 143')).toBeVisible();
    await expect(page.getByText('8 ingredients')).toBeVisible();
    await expect(page.getByText(/No ingredients/i)).toHaveCount(0);
    await expect(page).toHaveScreenshot('items-compact-light.png');
  });
});
