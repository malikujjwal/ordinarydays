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
        await expect(button).toHaveCSS('border-top-width', '1px');
        await expect(button.locator('svg')).toHaveCount(1);
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

test('Preparation progress fits a compact screen and names the full count', async ({
  page,
  request,
}, testInfo) => {
  const parent = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: {
      objectKind: 'plan',
      type: 'custom',
      title: 'Preparation count check',
      details: { kind: 'custom' },
    },
  });
  const { data: plan } = await parent.json();
  let childId: string | undefined;
  try {
    const response = await request.post(`${API}/v1/activities`, {
      headers: e2eHeaders(randomUUID()),
      data: {
        objectKind: 'task',
        type: 'task',
        title: 'Distinct prep task',
        parentActivityId: plan.activityId,
      },
    });
    expect(response.ok()).toBe(true);
    const { data: child } = await response.json();
    childId = child.activityId;
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(`/activity/${plan.activityId}`);
    const count = page.getByRole('button', { name: '0 of 1 done', exact: true });
    await count.scrollIntoViewIfNeeded();
    await expect(count).toBeVisible();
    const heading = page.getByRole('heading', { name: 'Preparation', exact: true });
    await expect(heading).toBeVisible();
    const headingBounds = await heading.boundingBox();
    if (headingBounds === null) throw new Error('Missing Preparation heading');
    expect(headingBounds.width).toBeGreaterThan(0);
    const bounds = await count.boundingBox();
    if (bounds === null) throw new Error('Missing Preparation count');
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(304);
    const addPrep = page.getByTestId('prep-add');
    const actionBounds = await addPrep.boundingBox();
    const iconBounds = await addPrep.locator('svg').boundingBox();
    if (actionBounds === null || iconBounds === null)
      throw new Error('Missing Prep action');
    expect(iconBounds.x).toBe(actionBounds.x);
    await page.screenshot({
      path: testInfo.outputPath('preparation-count.png'),
      fullPage: true,
    });
  } finally {
    await deleteActivities(request, [
      ...(childId === undefined ? [] : [childId]),
      plan.activityId,
    ]);
  }
});
