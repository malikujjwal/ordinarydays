import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { API, e2eHeaders } from '../support/api';

// A real configured List, not a mock row: this catches spacing across independently
// enabled features as well as the approved address-to-details / Maps separation.
test('mixed supporting lines form one compact detail target', async ({
  page,
  request,
}, testInfo) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const created = await request.post(`${API}/v1/lists`, {
    headers: e2eHeaders(randomUUID()),
    data: { title: 'Compact row regression', templateKey: 'blank' },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const {
    data: { listId, updatedAt },
  } = (await created.json()) as { data: { listId: string; updatedAt: string } };
  try {
    const config = await request.patch(`${API}/v1/lists/${listId}`, {
      headers: { ...e2eHeaders(randomUUID()), 'If-Match': updatedAt },
      data: {
        featureConfig: {
          progress: { enabled: true, kind: 'text' },
          place: { enabled: true },
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
          },
        },
      },
    });
    expect(config.ok(), await config.text()).toBe(true);
    const added = await request.post(`${API}/v1/lists/${listId}/items`, {
      headers: e2eHeaders(randomUUID()),
      data: {
        title: 'Lemon chicken rice',
        note: 'Bright lemon, herbs, and an easy pan sauce.',
        features: {
          progress: { kind: 'text', value: 'Recipe page 143' },
          place: {
            label: 'Market',
            address: '990 Washington Avenue, Brooklyn, New York',
          },
          subItems: { entries: [{ id: 'sub_1', title: 'Lemon', rank: 'a0' }] },
        },
      },
    });
    expect(added.ok(), await added.text()).toBe(true);
    const {
      data: { itemId },
    } = (await added.json()) as { data: { itemId: string } };
    await page.goto(`/lists/${listId}`);
    const row = page.getByTestId(`list-item-${itemId}`);
    await expect(row).toBeVisible();
    await page.evaluate(async () => document.fonts.ready);
    await page.screenshot({ path: testInfo.outputPath('mixed-row.png') });
    const lines = [
      'Lemon chicken rice',
      'Bright lemon, herbs, and an easy pan sauce.',
      'Recipe page 143',
      '990 Washington Avenue, Brooklyn, New York',
      '1 Ingredient',
    ];
    const boxes = await Promise.all(
      lines.map((text) => row.getByText(text, { exact: true }).boundingBox()),
    );
    for (let at = 1; at < boxes.length; at += 1) {
      const before = boxes[at - 1];
      const after = boxes[at];
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      if (before && after) expect(after.y - before.y - before.height).toBeCloseTo(4, 0);
    }
    await row.getByText(lines[3] ?? '', { exact: true }).click();
    await expect(page.getByTestId('item-sheet')).toBeVisible();
    await expect(page.getByTestId('item-sheet-title')).toHaveValue('Lemon chicken rice');
  } finally {
    const removed = await request.delete(`${API}/v1/lists/${listId}`, {
      headers: e2eHeaders(),
    });
    expect(removed.ok(), await removed.text()).toBe(true);
  }
});

const examples = [
  {
    template: 'blank',
    title: 'A Sunday without plans',
    note: 'Coffee, a walk, and time to read.',
    features: {},
  },
  {
    template: 'checklist',
    title: 'Pack for a quiet weekend',
    note: 'Bring the small notebook.',
    features: {},
  },
  {
    template: 'watch-later',
    title: 'Severance',
    note: 'Watch together after dinner.',
    features: { progress: { kind: 'episode', season: 2, episode: 4 } },
  },
  {
    template: 'books-to-read',
    title: 'The Creative Act',
    note: 'Keep a pencil nearby.',
    features: { progress: { kind: 'text', value: 'Page 143' } },
  },
  {
    template: 'places-to-visit',
    title:
      'Brooklyn Botanic Garden and the quiet paths through its Japanese hill and pond garden',
    note: 'A slow afternoon outdoors.',
    features: {
      place: {
        label: 'Brooklyn Botanic Garden',
        address:
          '990 Washington Avenue, between Eastern Parkway and Empire Boulevard, Brooklyn, New York 11225',
      },
    },
  },
  {
    template: 'meal-ideas',
    title: 'Lemon chicken rice',
    note: 'Bright lemon and herbs.',
    features: { subItems: { entries: [{ id: 'sub_1', title: 'Lemon', rank: 'a0' }] } },
  },
];

for (const appearance of ['light', 'dark', 'larger-text'] as const) {
  for (const example of examples) {
    test(`${example.template} rows: ${appearance}, wrapping, controls and persistence`, async ({
      page,
      request,
      context,
    }, testInfo) => {
      await page.setViewportSize({
        width: appearance === 'light' ? 375 : 320,
        height: 667,
      });
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light' });
      const created = await request.post(`${API}/v1/lists`, {
        headers: e2eHeaders(randomUUID()),
        data: { title: 'Compact row examples', templateKey: example.template },
      });
      expect(created.ok(), await created.text()).toBe(true);
      const { data: list } = (await created.json()) as {
        data: {
          listId: string;
          itemStateMode: {
            mode: string;
            labels?: { open: string; active: string; done: string };
          };
        };
      };
      const path = `${API}/v1/lists/${list.listId}/items`;
      try {
        const added = await request.post(path, {
          headers: e2eHeaders(randomUUID()),
          data: { title: example.title, note: example.note, features: example.features },
        });
        expect(added.ok(), await added.text()).toBe(true);
        const { data: item } = (await added.json()) as { data: { itemId: string } };
        const missingResponse = await request.post(path, {
          headers: e2eHeaders(randomUUID()),
          data: { title: 'An item without supporting details' },
        });
        expect(missingResponse.ok(), await missingResponse.text()).toBe(true);
        const { data: missing } = (await missingResponse.json()) as {
          data: { itemId: string };
        };
        const readItem = async () => {
          const response = await request.get(`${path}/${item.itemId}`, {
            headers: e2eHeaders(),
          });
          expect(response.ok(), await response.text()).toBe(true);
          return (
            (await response.json()) as {
              data: { state: string; features: unknown; note: string };
            }
          ).data;
        };
        const before = await readItem();
        await page.goto(`/lists/${list.listId}`);
        const row = page.getByTestId(`list-item-${item.itemId}`);
        const body = page.getByTestId(`list-item-${item.itemId}-body`);
        const missingRow = page.getByTestId(`list-item-${missing.itemId}`);
        await expect(row).toBeVisible();
        await page.evaluate(async () => document.fonts.ready);
        if (appearance === 'larger-text') {
          // Browser text stress, separate from real iOS Dynamic Type acceptance.
          await page.locator('[dir="auto"]').evaluateAll((nodes) => {
            for (const node of nodes) {
              if (!(node instanceof HTMLElement)) continue;
              const style = getComputedStyle(node);
              node.style.fontSize = `${Number.parseFloat(style.fontSize) * 2}px`;
              node.style.lineHeight = `${Number.parseFloat(style.lineHeight) * 2}px`;
            }
          });
        }
        await expectNoSeriousA11yViolations(
          page,
          `${example.template} List, ${appearance}`,
        );
        await page.screenshot({ path: testInfo.outputPath('rows.png') });
        for (const suffix of [
          'title',
          ...('place' in example.features ? ['place'] : []),
        ]) {
          const geometry = await page
            .getByTestId(`list-item-${item.itemId}-${suffix}`)
            .evaluate((node) => {
              const box = node.getBoundingClientRect();
              const range = document.createRange();
              range.selectNodeContents(node);
              const text = range.getBoundingClientRect();
              return {
                left: box.left,
                right: box.right,
                width: window.innerWidth,
                height: box.height,
                textHeight: text.height,
                overflow: node.scrollWidth - node.clientWidth,
              };
            });
          expect(geometry.left).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(geometry.width);
          expect(geometry.textHeight).toBeLessThanOrEqual(geometry.height + 1);
          expect(geometry.overflow).toBeLessThanOrEqual(1);
        }
        const noteBox = await row.getByText(example.note, { exact: true }).boundingBox();
        const titleBox = await row
          .getByText(example.title, { exact: true })
          .boundingBox();
        expect(noteBox).not.toBeNull();
        expect(titleBox).not.toBeNull();
        if (noteBox && titleBox)
          expect(noteBox.y - titleBox.y - titleBox.height).toBeCloseTo(4, 0);
        await expect(missingRow.locator('[data-testid$="-metadata"]')).toHaveCount(0);
        await expect(missingRow.locator('[data-testid$="-location"]')).toHaveCount(0);
        await expect(row.locator('[role="checkbox"]')).toHaveCount(
          list.itemStateMode.mode === 'checkbox' ? 1 : 0,
        );
        for (const control of await row
          .locator('[role="button"], [role="checkbox"]')
          .all()) {
          const box = await control.boundingBox();
          expect(box).not.toBeNull();
          if (box) {
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
          }
        }
        const gripBox = await page
          .getByTestId(`list-reorder-handle-${item.itemId}`)
          .boundingBox();
        const lastTarget =
          'place' in example.features
            ? page.getByTestId(`list-item-${item.itemId}-location`)
            : body;
        const lastBox = await lastTarget.boundingBox();
        expect(gripBox).not.toBeNull();
        expect(lastBox).not.toBeNull();
        if (gripBox && lastBox)
          expect(gripBox.x - lastBox.x - lastBox.width).toBeGreaterThanOrEqual(8);
        await body.focus();
        await expect(body).toBeFocused();
        await expect(body).toHaveCSS('outline-style', 'solid');
        await expect(body).toHaveCSS('outline-width', '2px');
        // Filtering is view state; it cannot mutate the item's intrinsic state or progress.
        if (list.itemStateMode.labels) {
          await page
            .getByRole('tab', { name: `${list.itemStateMode.labels.done}, 0` })
            .click();
          await expect(body).toHaveCount(0);
          await page.getByRole('tab', { name: 'All, 2' }).click();
          expect(await readItem()).toEqual(before);
        }
        if ('place' in example.features && example.features.place) {
          const maps = page.getByTestId(`list-item-${item.itemId}-location`);
          const popupPromise = context.waitForEvent('page');
          await context.route('https://www.google.com/maps/**', (route) =>
            route.fulfill({ status: 200, body: 'Map destination intercepted by test' }),
          );
          await maps.click();
          const popup = await popupPromise;
          await expect
            .poll(() => popup.url())
            .toContain(`query=${encodeURIComponent(example.features.place.address)}`);
          await popup.close();
          await expect(page.getByTestId('item-sheet')).toHaveCount(0);
          await row.getByText(example.features.place.address, { exact: true }).click();
        } else {
          if (example.template === 'checklist') {
            await row.getByRole('checkbox').click();
            await expect.poll(async () => (await readItem()).state).toBe('done');
            await expect(page.getByTestId('item-sheet')).toHaveCount(0);
          }
          await body.click();
        }
        await expect(page.getByTestId('item-sheet-title')).toHaveValue(example.title);
        await expectNoSeriousA11yViolations(page, `${example.template} Item details`);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByTestId('item-sheet')).toHaveCount(0);
        await page.reload();
        await expect(body).toBeVisible();
        const after = await readItem();
        expect(after.features).toEqual(before.features);
        expect(after.note).toEqual(before.note);
        expect(after.state).toBe(
          example.template === 'checklist' ? 'done' : before.state,
        );
      } finally {
        const deleted = await request.delete(`${API}/v1/lists/${list.listId}`, {
          headers: e2eHeaders(),
        });
        expect(deleted.ok(), await deleted.text()).toBe(true);
      }
    });
  }
}
