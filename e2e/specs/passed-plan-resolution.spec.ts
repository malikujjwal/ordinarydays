import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? '3000'}`;
const ZONE = 'America/New_York';

function wallDate(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function headers(idempotencyKey?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Request-Id': `req_e2e_${randomUUID().replaceAll('-', '')}`,
    'X-Client-Timezone': ZONE,
    'X-Client-Version': 'web/e2e',
    ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
  };
}

test('ignoring a passed-plan prompt never carries or faults the item tomorrow', async ({
  page,
  request,
}) => {
  const now = new Date();
  const today = wallDate(now);
  const tomorrowInstant = new Date(now.getTime() + 36 * 60 * 60 * 1000);
  const title = `Passed-plan E2E ${randomUUID()}`;
  const created = await request.post(`${API}/v1/activities`, {
    headers: headers(randomUUID()),
    data: {
      objectKind: 'plan',
      type: 'event',
      title,
      details: { kind: 'event' },
      schedule: { date: today, time: '00:00', timezone: ZONE },
    },
  });
  expect(created.ok()).toBe(true);
  const createdBody = (await created.json()) as { data: { activityId: string } };
  const activityId = createdBody.data.activityId;

  try {
    await page.clock.setFixedTime(now);
    await page.goto('/');

    const row = page
      .locator(`[data-testid="agenda-row-${activityId}"]`)
      .filter({ hasText: title });
    await expect(row).toBeVisible();
    await expect(
      row.getByRole('button', {
        name: `How did it go? Choose an outcome for ${title}`,
      }),
    ).toBeVisible();

    // Ignore it. Moving the client clock across midnight must query a new day, not nag.
    await page.clock.setFixedTime(tomorrowInstant);
    await page.goto('/');
    await expect(page.locator(`[data-testid="agenda-row-${activityId}"]`)).toHaveCount(0);
    await expect(page.getByText(title)).toHaveCount(0);

    // The current Phase-2 Plans surface is Upcoming-only. It must not introduce any
    // unresolved/fault presentation. The API integration test pins durable Past-stage
    // placement; the exact read below pins that ignoring the prompt did not resolve it.
    // Row absence is pinned above against the client clock's next-day agenda query; the API
    // server intentionally keeps its own wall clock rather than accepting a client test clock.
    await page.goto('/plans');
    await expect(page.locator('[data-testid="plans-screen"]')).toBeVisible();
    await expect(page.getByText(/unresolved|needs attention|overdue/i)).toHaveCount(0);

    const stored = await request.get(`${API}/v1/activities/${activityId}`, {
      headers: headers(),
    });
    expect(stored.ok()).toBe(true);
    const storedBody = (await stored.json()) as {
      data: { activity: { activityId: string; status: string } };
    };
    expect(storedBody.data.activity).toEqual(
      expect.objectContaining({ activityId, status: 'scheduled' }),
    );
  } finally {
    await page.clock.setFixedTime(new Date());
    await request.delete(`${API}/v1/activities/${activityId}`, { headers: headers() });
  }
});
