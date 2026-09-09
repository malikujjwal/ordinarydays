import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yViolations } from '../support/a11y';
import { API, e2eHeaders } from '../support/api';

for (const close of ['Close', 'Escape', 'scrim'] as const) {
  test(`autosave acknowledges the real write and ${close} still flushes without a guard`, async ({
    page,
    request,
  }, info) => {
    const created = await request.post(`${API}/v1/lists`, {
      headers: e2eHeaders(randomUUID()),
      data: { title: 'Item save regression', templateKey: 'blank' },
    });
    expect(created.ok()).toBe(true);
    const {
      data: { listId },
    } = await created.json();
    try {
      const added = await request.post(`${API}/v1/lists/${listId}/items`, {
        headers: e2eHeaders(randomUUID()),
        data: { title: 'An item whose edits must survive' },
      });
      expect(added.ok()).toBe(true);
      const {
        data: { itemId },
      } = await added.json();
      const url = `${API}/v1/lists/${listId}/items/${itemId}`;
      await page.goto(`/lists/${listId}`);
      const opener = page.getByTestId(`list-item-${itemId}-body`);
      await opener.click();
      await expect(page.getByText('Changes save automatically.')).toBeVisible();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrived: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      let writes = 0;
      await page.route(url, async (route) => {
        if (route.request().method() !== 'PATCH') return route.continue();
        writes += 1;
        if (writes === 1) {
          arrived();
          await held;
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'internal_error',
                message: 'Injected persistence failure',
                requestId: 'req_failure',
              },
            }),
          });
        } else await route.continue();
      });
      const note = page.getByTestId('item-sheet-note');
      await note.fill('First pending draft');
      await started;
      await expect(page.getByText('Saving…')).toBeVisible();
      await note.fill('The latest draft must survive');
      await expect(page.getByText('All changes saved')).toHaveCount(0);
      expect(writes).toBe(1);
      release();
      await expect(
        page.getByRole('button', { name: 'Retry', exact: true }),
      ).toBeVisible();
      await expect(note).toHaveValue('The latest draft must survive');
      await page.screenshot({ path: info.outputPath('failure-retains-draft.png') });
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByText('All changes saved')).toBeVisible();
      expect(writes).toBe(2);
      const persisted = await request.get(url, { headers: e2eHeaders() });
      expect((await persisted.json()).data.note).toBe('The latest draft must survive');
      await expectNoSeriousA11yViolations(page, 'Item details');
      await note.fill('Close flushes this final draft');
      if (close === 'Escape') await page.keyboard.press('Escape');
      else if (close === 'scrim') await page.mouse.click(5, 5);
      else await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByTestId('item-sheet')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Keep editing' })).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await (await request.get(url, { headers: e2eHeaders() })).json()).data.note,
        )
        .toBe('Close flushes this final draft');
      await opener.click();
      await expect(note).toHaveValue('Close flushes this final draft');
      await page.screenshot({ path: info.outputPath('reopened-saved-note.png') });
    } finally {
      const removed = await request.delete(`${API}/v1/lists/${listId}`, {
        headers: e2eHeaders(),
      });
      expect(removed.ok()).toBe(true);
    }
  });
}

const examples = [
  'blank',
  'checklist',
  'watch-later',
  'books-to-read',
  'places-to-visit',
  'meal-ideas',
] as const;
for (const example of examples) {
  for (const appearance of ['light', 'dark', 'large'] as const) {
    test(`${example} Item details at small size in ${appearance}`, async ({
      page,
      request,
    }, info) => {
      await page.setViewportSize({ width: 320, height: 667 });
      await page.emulateMedia({ colorScheme: appearance === 'dark' ? 'dark' : 'light' });
      const response = await request.post(`${API}/v1/lists`, {
        headers: e2eHeaders(randomUUID()),
        data: { title: 'Item details example', templateKey: example },
      });
      expect(response.ok()).toBe(true);
      const {
        data: { listId, itemStateMode, featureConfig },
      } = await response.json();
      try {
        const features = {
          ...(example === 'places-to-visit'
            ? {
                place: {
                  label: 'Brooklyn Botanic Garden',
                  address:
                    '990 Washington Avenue, Brooklyn, New York 11225 near the Eastern Parkway entrance',
                },
              }
            : {}),
          ...(example === 'watch-later'
            ? { progress: { kind: 'episode', season: 2, episode: 4 } }
            : {}),
          ...(example === 'books-to-read'
            ? {
                progress: { kind: 'text', value: 'Page 143 — start at the next chapter' },
              }
            : {}),
          ...(example === 'meal-ideas'
            ? {
                subItems: {
                  entries: [
                    {
                      id: 'sub_1',
                      title:
                        'Fresh cherry tomatoes with the long descriptive ingredient name',
                      secondary: '250 grams',
                      rank: 'a0',
                    },
                  ],
                },
              }
            : {}),
        };
        const added = await request.post(`${API}/v1/lists/${listId}/items`, {
          headers: e2eHeaders(randomUUID()),
          data: {
            title:
              'A long item title whose complete words must remain editable on a small screen',
            note: 'Remember the detailed instructions and keep them available when returning to this item.',
            features,
          },
        });
        expect(added.ok()).toBe(true);
        const {
          data: { itemId },
        } = await added.json();
        await page.goto(`/lists/${listId}`);
        await page.getByTestId(`list-item-${itemId}-body`).click();
        if (appearance === 'large')
          await page.addStyleTag({
            content:
              'input, textarea, [data-testid="item-sheet"] [dir="auto"] { font-size: 200% !important; line-height: 1.3 !important; }',
          });
        await expect(page.getByTestId('item-sheet-title')).toHaveValue(
          /A long item title/,
        );
        const body = page.getByTestId('item-sheet-body');
        const status = page.getByTestId('item-save-status');
        expect(
          await body.evaluate((element) =>
            element.contains(document.querySelector('[data-testid="item-save-status"]')),
          ),
        ).toBe(false);
        await page.screenshot({ path: info.outputPath('item-top.png') });
        if (itemStateMode.mode !== 'none') {
          const done = page.getByTestId('item-state-done');
          await done.scrollIntoViewIfNeeded();
          await expect(done).toHaveAttribute('aria-pressed', 'false');
          await done.click();
          await expect(done).toHaveAttribute('aria-pressed', 'true');
          const bounds = await done.boundingBox();
          expect(bounds?.height).toBeGreaterThanOrEqual(44);
          expect(bounds?.width).toBeGreaterThanOrEqual(44);
        } else await expect(page.getByTestId('item-state-editor')).toHaveCount(0);
        if (featureConfig.place?.enabled) {
          await expect(page.getByLabel('Name', { exact: true })).toHaveValue(
            'Brooklyn Botanic Garden',
          );
          await page.getByLabel('Address').fill('');
          await page.getByLabel('Name', { exact: true }).fill('');
        }
        if (featureConfig.subItems?.enabled) {
          await expect(
            page.getByRole('button', { name: /Edit Fresh cherry/ }),
          ).toHaveCount(1);
          await page.getByRole('button', { name: /Edit Fresh cherry/ }).click();
          await expect(
            page.getByLabel(featureConfig.subItems.singularLabel, { exact: true }),
          ).toBeFocused();
        }
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect(
          page.getByRole('button', { name: 'Delete item', exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expect(status).toBeInViewport({ ratio: 1 });

        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(320);
        await expectNoSeriousA11yViolations(page, 'Item details');
        await page.screenshot({ path: info.outputPath('item-scrolled.png') });
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(page.getByTestId('list-detail')).toBeVisible();
      } finally {
        const removed = await request.delete(`${API}/v1/lists/${listId}`, {
          headers: e2eHeaders(),
        });
        expect(removed.ok()).toBe(true);
      }
    });
  }
}
