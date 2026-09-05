import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API, deleteActivities, e2eHeaders } from '../support/api';

for (const textSize of [13, 52]) {
  test(`Plan add actions stay within a 320px screen at ${textSize}px text`, async ({
    page,
    request,
  }, testInfo) => {
    const response = await request.post(`${API}/v1/activities`, {
      headers: e2eHeaders(randomUUID()),
      data: {
        objectKind: 'plan',
        type: 'custom',
        title: 'Small screen action check',
        details: { kind: 'custom' },
      },
    });
    expect(response.ok()).toBe(true);
    const { data } = await response.json();
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.goto(`/activity/${data.activityId}`);
      const actions = page.getByTestId('add-to-plan');
      await expect(actions).toBeVisible();
      // Browser text stress test, not a substitute for native Dynamic Type verification.
      await page.addStyleTag({
        content: `[data-testid="add-to-plan"] [dir="auto"] { font-size: ${textSize}px !important; line-height: 1.3 !important; }`,
      });
      for (const id of ['prep-task', 'list', 'photo']) {
        const button = page.getByTestId(`add-to-plan-${id}`);
        await button.scrollIntoViewIfNeeded();
        await expect(button).toBeVisible();
        const bounds = await button.boundingBox();
        if (bounds === null) throw new Error(`Missing action bounds: ${id}`);
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
      }
      await page.screenshot({
        path: testInfo.outputPath('plan-actions.png'),
        fullPage: true,
      });
      await page.getByTestId('add-to-plan-photo').click();
      await expect(page.getByTestId('attachment-sheet')).toBeVisible();
      await page.addStyleTag({
        content: `[data-testid="attachment-sheet"] [role="button"] [dir="auto"] { font-size: ${textSize}px !important; line-height: 1.3 !important; }`,
      });
      for (const id of ['attachment-picker-photos', 'attachment-sheet-done']) {
        const button = page.getByTestId(id);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox();
        const label = await button
          .getByText(id.endsWith('photos') ? 'Photos' : 'Done', { exact: true })
          .boundingBox();
        if (box === null || label === null)
          throw new Error(`Missing photo control: ${id}`);
        expect(label.y).toBeGreaterThanOrEqual(box.y);
        expect(label.y + label.height).toBeLessThanOrEqual(box.y + box.height);
      }
      await page.screenshot({
        path: testInfo.outputPath('photo-controls.png'),
        fullPage: true,
      });
    } finally {
      await deleteActivities(request, [data.activityId]);
    }
  });
}
