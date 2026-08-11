import { expect, type Page, test } from '@playwright/test';

const testId = (page: Page, id: string) => page.locator(`[data-testid="${id}"]`);

test('cold-opening Today makes one bounded agenda request', async ({ page }) => {
  const agendaRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/v1/agenda') {
      agendaRequests.push(request.url());
    }
  });

  const agendaResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/v1/agenda',
  );
  await page.goto('/');
  const response = await agendaResponse;

  await expect(testId(page, 'today-screen')).toBeVisible();
  await expect(testId(page, 'today-agenda')).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(agendaRequests).toHaveLength(1);
  const agendaRequest = agendaRequests[0];
  if (agendaRequest === undefined) throw new Error('Today made no agenda request.');
  const request = new URL(agendaRequest);
  expect(request.searchParams.get('from')).toBe(request.searchParams.get('to'));
  expect(request.searchParams.get('include')).toBe('anytime_unscheduled,overdue');
  expect(request.searchParams.get('include')).not.toContain('reminders');

  const body = (await response.json()) as {
    data: {
      days: Array<{
        schedule: Array<{ title: string }>;
        anytime: Array<{ title: string }>;
        earlier: Array<{ title: string }>;
      }>;
    };
  };
  const titles = body.data.days.flatMap((day) =>
    [...day.schedule, ...day.anytime, ...day.earlier].map((item) => item.title),
  );

  // These are the local seed's undated `#P` Plans. P2-08 must omit them rather than asking
  // this client partition to rediscover object kind, presentation type, or participants.
  expect(titles).not.toContain('Poconos trip');
  expect(titles).not.toContain('Dinner at Zahav');
  expect(titles).not.toContain('Watch Severance');
});
