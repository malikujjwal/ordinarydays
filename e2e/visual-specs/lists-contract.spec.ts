import { expect, type Page, test } from '@playwright/test';

async function openFrame(
  page: Page,
  frame:
    | 'create'
    | 'settings'
    | 'stages'
    | 'items'
    | 'overview'
    | 'empty'
    | 'checklist'
    | 'context-add'
    | 'global-add',
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

  for (const scheme of ['light', 'dark'] as const) {
    test(`coloured index compact ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'overview', scheme);
      await expect(page.getByText('Lists contract gallery')).toBeVisible();
      await expect(page).toHaveScreenshot(`overview-compact-${scheme}.png`);
    });
  }

  test('creation chooser is explicit and unselected', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'create');
    await expect(page.getByTestId('new-list-sheet')).toBeVisible();
    await expect(page.getByTestId('new-list-title-step')).toHaveCount(0);
    await expect(page).toHaveScreenshot('create-compact-light.png');
  });

  test('creation chooser reflows at 320 without horizontal overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openFrame(page, 'create');
    await expect(page.getByTestId('list-style-grid')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page).toHaveScreenshot('create-320-light.png');
  });

  test('empty List has one compact primary action', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'empty');
    await expect(page.getByText('Start with one item')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add item' })).toHaveCount(1);
    await expect(page).toHaveScreenshot('empty-compact-light.png');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`checklist anatomy compact ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'checklist', scheme);
      await expect(page.getByText('Drag handles to reorder')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add an item' })).toBeVisible();
      await expect(page).toHaveScreenshot(`checklist-compact-${scheme}.png`);
    });
  }

  test('checklist grips retain 44-point targets at 320', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openFrame(page, 'checklist');
    const grip = page.getByRole('button', { name: 'Reorder Paper towels' });
    await grip.focus();
    const box = await grip.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page).toHaveScreenshot('checklist-320-light.png');
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

  test('contextual composer stays anchored over its List', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'context-add');
    await expect(page.getByTestId('list-contextual-add')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Add item to Weekend packing' }),
    ).toBeVisible();
    await expect(page.getByLabel('Note')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await expect(page).toHaveScreenshot('context-add-compact-light.png');
  });

  test('global composer keeps destination inline and initially unselected', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'global-add');
    await expect(page.getByTestId('compose-list-item')).toBeVisible();
    await expect(page.getByText('Add to')).toBeVisible();
    await expect(page.getByText('Which list?')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose a list' })).toBeDisabled();
    await expect(page).toHaveScreenshot('global-add-compact-light.png');
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
