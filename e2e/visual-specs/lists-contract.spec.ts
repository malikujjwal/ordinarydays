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
    | 'global-add'
    | 'item-details'
    | 'index-menu'
    | 'detail-menu'
    | 'detail-menu-empty'
    | 'short-header'
    | 'long-header'
    | 'context-add-long'
    | 'delete',
  scheme: 'light' | 'dark' = 'light',
) {
  await page.goto(
    `/lists-contract-gallery?contract=p3-33&frame=${frame}&scheme=${scheme}`,
  );
  await page.evaluate(async () => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
}

async function openTabFrame(
  page: Page,
  frame: 'index-chrome' | 'index-chrome-empty' | 'index-chrome-loading',
  scheme: 'light' | 'dark' = 'light',
) {
  await page.goto(`/lists-contract-tab-gallery?frame=${frame}&scheme=${scheme}`);
  await page.evaluate(async () => document.fonts.ready);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme });
}

async function installKeyboardViewport(page: Page, initialInset: number) {
  await page.addInitScript((inset) => {
    const viewport = new EventTarget() as EventTarget & {
      height: number;
      offsetTop: number;
      width: number;
      offsetLeft: number;
      pageLeft: number;
      pageTop: number;
      scale: number;
    };
    Object.assign(viewport, {
      height: window.innerHeight - inset,
      offsetTop: 0,
      width: window.innerWidth,
      offsetLeft: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1,
    });
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });
    Object.defineProperty(window, '__setContractKeyboardInset', {
      configurable: true,
      value: (nextInset: number) => {
        viewport.height = window.innerHeight - nextInset;
        viewport.dispatchEvent(new Event('resize'));
      },
    });
  }, initialInset);
}

async function setKeyboardInset(page: Page, inset: number) {
  await page.evaluate((nextInset) => {
    (
      window as typeof window & {
        __setContractKeyboardInset: (value: number) => void;
      }
    ).__setContractKeyboardInset(nextInset);
  }, inset);
}

async function expectAboveKeyboard(page: Page, testId: string, inset: number) {
  await expect
    .poll(async () => {
      const box = await page.getByTestId(testId).boundingBox();
      return box === null ? Number.POSITIVE_INFINITY : box.y + box.height;
    })
    .toBeLessThanOrEqual(844 - inset);
}

async function emulateLargestText(page: Page) {
  await page.locator('[dir="auto"]').evaluateAll((nodes) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const style = getComputedStyle(node);
      node.style.fontSize = `${String(Number.parseFloat(style.fontSize) * 2)}px`;
      node.style.lineHeight = `${String(Number.parseFloat(style.lineHeight) * 2)}px`;
    }
  });
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
      const nextInColumn = page.getByRole('button', { name: /^Checklist\./ });
      const secondColumn = page.getByRole('button', { name: /^Places to Visit\./ });
      const heading = page.getByText('Lists contract gallery');
      await expect(first).toBeVisible();
      await expect(secondColumn).toBeVisible();

      const [firstBox, nextBox, secondColumnBox, headingBox] = await Promise.all([
        first.boundingBox(),
        nextInColumn.boundingBox(),
        secondColumn.boundingBox(),
        heading.boundingBox(),
      ]);
      expect(firstBox).not.toBeNull();
      expect(nextBox).not.toBeNull();
      expect(secondColumnBox).not.toBeNull();
      expect(headingBox).not.toBeNull();
      if (
        firstBox === null ||
        nextBox === null ||
        secondColumnBox === null ||
        headingBox === null
      )
        return;

      expect(Math.abs(firstBox.y - secondColumnBox.y)).toBeLessThan(1);
      expect(Math.abs(firstBox.width - secondColumnBox.width)).toBeLessThan(1);
      expect(secondColumnBox.x - (firstBox.x + firstBox.width)).toBeCloseTo(12, 0);
      expect(nextBox.y - (firstBox.y + firstBox.height)).toBeCloseTo(12, 0);
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

    test(`List-card long press opens a touch-friendly action sheet ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openTabFrame(page, 'index-chrome', scheme);
      const card = page.locator('[data-testid^="swipeable-list-"]').first();
      await card.dispatchEvent('pointerdown', {
        pointerId: 1,
        pointerType: 'touch',
        button: 0,
      });
      await page.waitForTimeout(520);
      await card.dispatchEvent('pointerup', {
        pointerId: 1,
        pointerType: 'touch',
        button: 0,
      });

      const dialog = page.getByRole('dialog', { name: 'Untitled list actions' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Archive' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Delete' })).toBeVisible();
      await expect(page).toHaveScreenshot(`index-card-actions-compact-${scheme}.png`);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`the final List and archived Restore clear real tab chrome ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openTabFrame(page, 'index-chrome', scheme);
      await page.getByTestId('lists-contract-index-scroll').evaluate((scroll) => {
        scroll.scrollTop = scroll.scrollHeight;
      });

      const tab = page.getByRole('tab', { name: 'Lists' });
      const lastActive = page.getByRole('button', { name: /^Road trip stops\./ });
      const restore = page.getByRole('button', {
        name: 'Restore Archived reading list',
      });
      const [tabBox, activeBox, restoreBox] = await Promise.all([
        tab.boundingBox(),
        lastActive.boundingBox(),
        restore.boundingBox(),
      ]);
      if (tabBox === null || activeBox === null || restoreBox === null) {
        throw new Error('Tab and final Lists controls must have layout boxes');
      }
      expect(activeBox.y + activeBox.height).toBeLessThan(tabBox.y);
      expect(restoreBox.y + restoreBox.height).toBeLessThan(tabBox.y);
      expect(
        await restore.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2),
          );
        }),
      ).toBe(true);
      await expect(page).toHaveScreenshot(`overview-last-compact-${scheme}.png`);
    });
  }

  test('empty and loading Lists states remain above real tab chrome', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const frame of ['index-chrome-empty', 'index-chrome-loading'] as const) {
      await openTabFrame(page, frame);
      const tabBox = await page.getByRole('tab', { name: 'Lists' }).boundingBox();
      const contentBox = await (frame === 'index-chrome-empty'
        ? page.getByRole('button', { name: 'New list' }).last()
        : page.getByTestId('lists-contract-loading')
      ).boundingBox();
      if (tabBox === null || contentBox === null) {
        throw new Error('Tab and terminal state content must have layout boxes');
      }
      expect(contentBox.y + contentBox.height).toBeLessThan(tabBox.y);
    }
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`Lists index More uses compact rows ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'index-menu', scheme);
      await expect(page.getByRole('checkbox', { name: /Hide archived/ })).toBeVisible();
      await expect(page).toHaveScreenshot(`index-menu-compact-${scheme}.png`);
    });

    test(`List detail More uses compact rows ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'detail-menu', scheme);
      await expect(page.getByRole('button', { name: 'Clear checked (4)' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Delete list' })).toBeVisible();
      await expect(page).toHaveScreenshot(`detail-menu-compact-${scheme}.png`);
    });

    test(`long List header keeps fixed actions ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'long-header', scheme);
      await expect(
        page.getByRole('button', { name: /Rename Everything to remember/ }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Share' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'More' })).toBeVisible();
      await expect(page).toHaveScreenshot(`long-header-compact-${scheme}.png`);
    });

    test(`long List contextual composer stays focused above the keyboard ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await installKeyboardViewport(page, 336);
      await openFrame(page, 'context-add-long', scheme);
      await expect(page.getByLabel('Title')).toBeFocused();
      await expectAboveKeyboard(page, 'list-contextual-add', 336);
      await expect(page).toHaveScreenshot(`context-add-long-compact-${scheme}.png`);
    });
  }

  test('keyboard resize and repeated contextual adds retain focus and clearance', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installKeyboardViewport(page, 336);
    await openFrame(page, 'context-add-long');
    const title = page.getByLabel('Title');

    for (const value of ['Rapid item 1', 'Rapid item 2', 'Rapid item 3']) {
      await title.fill(value);
      await title.press('Enter');
      await expect(title).toHaveValue('');
      await expect(title).toBeFocused();
      await expect(page.getByText(value)).toBeVisible();
      await expectAboveKeyboard(page, 'list-contextual-add', 336);
    }

    await setKeyboardInset(page, 280);
    await expectAboveKeyboard(page, 'list-contextual-add', 280);
    await setKeyboardInset(page, 0);
    await expect(page.getByTestId('list-contextual-add')).toBeInViewport({ ratio: 1 });
    await expect(title).toBeFocused();
  });

  test('largest text keeps the List header and menu actions reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'long-header');
    await emulateLargestText(page);
    await expect(page.getByRole('button', { name: 'Share' })).toBeInViewport({
      ratio: 1,
    });
    await expect(page.getByRole('button', { name: 'More' })).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await expect(page).toHaveScreenshot('long-header-large-text-light.png');

    await openFrame(page, 'detail-menu');
    await emulateLargestText(page);
    await page.getByTestId('list-header-menu-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Delete list' })).toBeInViewport({
      ratio: 1,
    });
    await expect(page).toHaveScreenshot('detail-menu-large-text-light.png');

    await openFrame(page, 'item-details');
    await emulateLargestText(page);
    await page.getByTestId('item-sheet-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Delete item' })).toBeInViewport({
      ratio: 1,
    });
    await expect(page).toHaveScreenshot('item-details-large-text-light.png');
  });

  test('List detail More omits inapplicable checked actions', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFrame(page, 'detail-menu-empty');
    await expect(page.getByText(/Clear checked/)).toHaveCount(0);
    await expect(page.getByText(/Uncheck all/)).toHaveCount(0);
    await expect(page).toHaveScreenshot('detail-menu-no-checked-compact-light.png');
  });

  test('short List header stays leading-aligned at 320', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openFrame(page, 'short-header');
    await expect(page.getByRole('button', { name: 'Rename Errands' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await expect(page).toHaveScreenshot('short-header-320-light.png');
  });

  test('maximum item details remain scrollable at 320', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await openFrame(page, 'item-details');
    await page.getByTestId('item-sheet-body').evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Delete item' })).toBeInViewport({
      ratio: 1,
    });
    await expect(page).toHaveScreenshot('item-details-320-light.png');
  });

  test('item details use the centred expanded sheet without stretching rows', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFrame(page, 'item-details');
    await expect(page.getByTestId('item-sheet')).toBeVisible();
    await expect(page).toHaveScreenshot('item-details-expanded-light.png');
  });

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
      await expect(page.getByText('3 items · 1 checked')).toBeVisible();
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

    test(`Sub-item settings compact ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'settings', scheme);
      await page.getByTestId('list-settings-sub-item-naming').click();
      await expect(page.getByTestId('sub-item-settings-sheet')).toBeVisible();
      await expect(page.getByTestId('sub-item-settings-preview')).toBeVisible();
      await expect(page).toHaveScreenshot(`sub-item-settings-compact-${scheme}.png`);
    });
  }

  test('settings expanded uses the shared centred-sheet geometry', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFrame(page, 'settings');
    await expect(page.getByTestId('list-settings')).toBeVisible();
    await expect(page).toHaveScreenshot('settings-expanded-light.png');
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`generic stages hide no populated group and keep configured labels ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'stages', scheme);
      await expect(page.getByTestId('list-state-sections')).toBeVisible();
      await expect(page.getByText('Queued').first()).toBeVisible();
      await expect(page.getByText('Building').first()).toBeVisible();
      await expect(page.getByText('Shipped').first()).toBeVisible();
      await expect(page.getByTestId('list-header')).toBeInViewport({ ratio: 1 });
      await expect(page).toHaveScreenshot(`stages-compact-${scheme}.png`);
    });

    test(`contextual composer renders inline in its List ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'context-add', scheme);
      await expect(page.getByTestId('list-contextual-add')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Add item to Weekend packing' }),
      ).toBeVisible();
      await expect(page.getByLabel('Title')).toBeFocused();
      await expect(page.getByLabel('Note')).toBeVisible();
      await expect(page.getByText('Optional')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Add to Weekend packing' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(page.getByTestId('list-title')).toBeVisible();
      await expect(page).toHaveScreenshot(`context-add-compact-${scheme}.png`);
    });

    test(`global Add offers Add list without a List-item page ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'global-add', scheme);
      await expect(page.getByTestId('object-chooser')).toBeVisible();
      await expect(page.getByRole('button', { name: /Task,/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Plan,/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Add list,/ })).toBeVisible();
      await expect(page.getByTestId('compose-list-item')).toHaveCount(0);
      await expect(page.getByText('Which list?')).toHaveCount(0);
      await expect(page).toHaveScreenshot(`global-add-compact-${scheme}.png`);
    });

    test(`inline rename stays in the standard header ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'checklist', scheme);
      await page.getByRole('button', { name: 'Rename Weekend packing' }).click();
      await expect(page.getByLabel('List name')).toBeFocused();
      await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
      await expect(page).toHaveScreenshot(`rename-compact-${scheme}.png`);
    });

    test(`item details and Sub-items stay compact ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'item-details', scheme);
      await expect(page.getByRole('dialog', { name: 'Item details' })).toBeVisible();
      await expect(page.getByTestId('sub-items-editor')).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Reorder Ingredient 1' }),
      ).toBeVisible();
      await expect(page).toHaveScreenshot(`item-details-compact-${scheme}.png`);
    });

    test(`delete List uses the centred consequence dialog ${scheme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openFrame(page, 'delete', scheme);
      await expect(
        page.getByRole('alertdialog', { name: 'Delete "Weekend packing"?' }),
      ).toBeVisible();
      await expect(page.getByText('18 List items will be removed')).toBeVisible();
      await expect(page.getByText('Linked Plans will remain')).toBeVisible();
      await expect(page.getByText('2 other people will lose access')).toBeVisible();
      await expect(page).toHaveScreenshot(`delete-compact-${scheme}.png`);
    });
  }

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
