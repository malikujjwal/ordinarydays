import { randomUUID } from 'node:crypto';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { API, e2eHeaders } from '../support/api';

/**
 * `+ Add prep task` end to end (P3-38,
 * [`plans-and-lists.md`](../../docs/01-product/plans-and-lists.md) §2.2).
 *
 * The task's own required pair: create `Book hotel` from the Plan's `+ Add prep task` and
 * assert the request carries `type: 'task'` and the current `parentActivityId`; then push the
 * same words through global `+` → `Plan` → `General` and assert they stay a standalone
 * `custom` Plan. The parent is explicit context, never something the title implies.
 */

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

async function createPlan(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post(`${API}/v1/activities`, {
    headers: e2eHeaders(randomUUID()),
    data: { objectKind: 'plan', type: 'custom', title, details: { kind: 'custom' } },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const body = (await response.json()) as { data: { activityId: string } };
  return body.data.activityId;
}

function captureCreateBodies(page: Page): unknown[] {
  const bodies: unknown[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url() === `${API}/v1/activities`) {
      bodies.push(sent.postDataJSON());
    }
  });
  return bodies;
}

test('Add prep task fixes the Task and its parent, and the section shows the result', async ({
  page,
  request,
}) => {
  const stamp = Date.now();
  const parentId = await createPlan(request, `Tokyo trip ${stamp}`);
  const bodies = captureCreateBodies(page);

  await page.goto(`/activity/${parentId}`);
  await expect(testId(page, 'detail-title')).toHaveValue(`Tokyo trip ${stamp}`);

  // An empty plan surfaces the flow through the `Add to this plan` chip row (§2.1).
  await testId(page, 'add-to-plan-prep-task').click();

  // The Task form directly — the parent already made the choice, so no chooser step.
  await expect(testId(page, 'compose-form')).toBeVisible();
  await expect(testId(page, 'object-chooser')).toHaveCount(0);
  await testId(page, 'compose-title').fill(`Book hotel ${stamp}`);

  // The final action names the write: a task, not a plan.
  await expect(testId(page, 'compose-save')).toHaveText('Save task');
  await testId(page, 'compose-save').click();

  // Back on the Plan, whose PREP section now holds the new child.
  await expect(testId(page, 'section-prep')).toBeVisible();
  await expect(page.getByText(`Book hotel ${stamp}`)).toBeVisible();

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({
    objectKind: 'task',
    type: 'task',
    title: `Book hotel ${stamp}`,
    parentActivityId: parentId,
  });
});

test('the same words through global Add stay a standalone custom Plan', async ({
  page,
}) => {
  const stamp = Date.now();
  const bodies = captureCreateBodies(page);

  await page.goto('/plans');
  await expect(testId(page, 'plans-screen')).toBeVisible();

  await testId(page, 'global-add').click();
  await expect(testId(page, 'object-chooser')).toBeVisible();
  await testId(page, 'compose-title').fill(`Book hotel ${stamp}`);
  await testId(page, 'object-choice-plan').click();
  await page.getByRole('button', { name: /^General,/ }).click();
  await expect(testId(page, 'compose-save')).toHaveText('Create plan');
  await testId(page, 'compose-save').click();
  await expect(testId(page, 'plans-screen')).toBeVisible();

  expect(bodies).toHaveLength(1);
  expect(bodies[0]).toMatchObject({ objectKind: 'plan', type: 'custom' });
  expect(bodies[0]).not.toHaveProperty('parentActivityId');
});
