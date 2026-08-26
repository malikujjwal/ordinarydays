import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

/**
 * The Plans tab against DynamoDB Local (§P3-20).
 *
 * What only a database shows is the boundary work: that a row stored in Tokyo and a row stored
 * in Los Angeles land in exactly one viewer-local stage each, that `#N` contributes nothing
 * because the bucket is never queried, and that `nextFrom` is a **converted** date rather than
 * the raw key it was read under. Those are the cases where an off-by-one is invisible in a
 * unit test and wrong on somebody's screen.
 */

type AppModule = typeof import('../../src/app.js');

let createApp: AppModule['createApp'];

beforeAll(async () => {
  createApp = (await import('../../src/app.js')).createApp;
});

const TZ = 'America/New_York';
const app = () => createApp();

const post = (path: string, body: unknown) =>
  app().fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );

const plans = (query: string) =>
  app().fetch(new Request(`http://localhost/v1/plans?${query}`));

const dataOf = async (response: Response) => (await response.json()).data;

/** Today in the request timezone, which is the boundary every stage is measured against. */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());

const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const createPlan = async (body: Record<string, unknown>) => {
  const res = await post('/v1/activities', {
    objectKind: 'plan',
    type: 'event',
    ...body,
  });
  expect(res.status).toBe(201);
  return dataOf(res);
};

const createTask = async (body: Record<string, unknown>) => {
  const res = await post('/v1/activities', {
    objectKind: 'task',
    type: 'task',
    ...body,
  });
  expect(res.status).toBe(201);
  return dataOf(res);
};

describe('mode=initial', () => {
  it('returns the three stages in one request', async () => {
    const undated = await createPlan({ title: 'Poconos trip' });
    const soon = await createPlan({
      title: 'Dinner',
      schedule: { date: addDays(today(), 3), timezone: TZ, time: '19:30' },
    });
    const gone = await createPlan({
      title: 'Last month',
      schedule: { date: addDays(today(), -20), timezone: TZ },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    expect(data.mode).toBe('initial');
    expect(data.needsDate.map((row: { activityId: string }) => row.activityId)).toContain(
      undated.activityId,
    );
    expect(
      data.upcoming.flatMap((day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
      ),
    ).toContain(soon.activityId);
    expect(
      data.past.flatMap((day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
      ),
    ).toContain(gone.activityId);
  });

  it('orders needsDate by lastActivityAt descending', async () => {
    const first = await createPlan({ title: 'Oldest' });
    const second = await createPlan({ title: 'Middle' });
    const third = await createPlan({ title: 'Newest' });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const order = data.needsDate.map((row: { activityId: string }) => row.activityId);

    expect(order).toEqual([third.activityId, second.activityId, first.activityId]);
  });

  /**
   * The stage's own promise: a plan people are talking about floats up. Asserted after the
   * write has converged rather than on the immediately following read, because GSI1 is
   * eventually consistent and the mutation response — not the index — is what moves the
   * client's row straight away.
   */
  it('moves a touched plan to the head once the projection has converged', async () => {
    const oldest = await createPlan({ title: 'Oldest' });
    await createPlan({ title: 'Newer' });

    const posted = await post(`/v1/activities/${oldest.activityId}/updates`, {
      body: 'Any thoughts on dates?',
    });
    expect(posted.status).toBe(201);
    const authoritative = (await posted.json()).data.lastActivityAt;

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    expect(data.needsDate[0]?.activityId).toBe(oldest.activityId);
    // The row carries the same value the mutation returned, so a client merging monotonically
    // never has to choose between the two.
    expect(data.needsDate[0]?.lastActivityAt).toBe(authoritative);
  });

  it('carries the zero RSVP projection and no suggestions', async () => {
    await createPlan({ title: 'Poconos trip' });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    expect(data.needsDate[0]?.rsvpSummary).toEqual({
      interested: { count: 0, names: [] },
      maybe: { count: 0, names: [] },
      pass: { count: 0, names: [] },
      pending: { count: 0, names: [] },
    });
    expect(data.needsDate[0]?.suggestionCount).toBe(0);
  });

  /** §1.3.2: there is nothing here a client could bind to tab chrome. */
  it('returns no stage-level count, total, unread or badge', async () => {
    await createPlan({ title: 'Poconos trip' });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    for (const field of ['count', 'total', 'unread', 'badge', 'needsDateCount']) {
      expect(data).not.toHaveProperty(field);
    }
    expect(Object.keys(data).sort()).toEqual([
      'mode',
      'needsDate',
      'past',
      'pastPage',
      'upcoming',
      'upcomingWindow',
      'warnings',
    ]);
  });
});

describe('what Plans does not show', () => {
  /**
   * Enforced by **not querying** `#N`, not by filtering afterwards — which is why an undated
   * task appearing anywhere would mean the bucket had been read.
   */
  it('shows an undated task in no stage', async () => {
    const anytime = await createTask({ title: 'Buy milk' });
    await createPlan({ title: 'Poconos trip' });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const everything = [
      ...data.needsDate.map((row: { activityId: string }) => row.activityId),
      ...data.upcoming.flatMap((day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
      ),
      ...data.past.flatMap((day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
      ),
    ];

    expect(everything).not.toContain(anytime.activityId);
  });

  /** Dated Tasks share `#S` with Plans and stay: the tab is everything with a date. */
  it('shows a dated task exactly once, in the right stage', async () => {
    const upcoming = await createTask({
      title: 'Return the rental car',
      schedule: { date: addDays(today(), 4), timezone: TZ },
    });
    const past = await createTask({
      title: 'Renew the passport',
      schedule: { date: addDays(today(), -4), timezone: TZ },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const upcomingIds = data.upcoming.flatMap(
      (day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
    );
    const pastIds = data.past.flatMap((day: { items: { activityId: string }[] }) =>
      day.items.map((item) => item.activityId),
    );

    expect(upcomingIds.filter((id: string) => id === upcoming.activityId)).toHaveLength(
      1,
    );
    expect(pastIds.filter((id: string) => id === past.activityId)).toHaveLength(1);
    expect(upcomingIds).not.toContain(past.activityId);
    expect(pastIds).not.toContain(upcoming.activityId);
  });
});

describe('timezone boundaries', () => {
  /**
   * Two rows stored on either side of the request zone, both on the stored date that would
   * put them in the wrong stage if the key were trusted. Conversion is what decides, so each
   * must land in exactly one stage.
   */
  it('places rows stored in other zones by their converted date', async () => {
    const boundary = today();

    // 23:00 in Tokyo on today's date is still today in Tokyo, but yesterday in New York.
    const tokyo = await createPlan({
      title: 'Tokyo evening',
      schedule: { date: boundary, timezone: 'Asia/Tokyo', time: '09:00' },
    });
    // 22:00 in Los Angeles on yesterday's date is still yesterday there — and yesterday here.
    const losAngeles = await createPlan({
      title: 'LA night',
      schedule: {
        date: addDays(boundary, -1),
        timezone: 'America/Los_Angeles',
        time: '22:00',
      },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const upcomingIds = data.upcoming.flatMap(
      (day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
    );
    const pastIds = data.past.flatMap((day: { items: { activityId: string }[] }) =>
      day.items.map((item) => item.activityId),
    );

    for (const id of [tokyo.activityId, losAngeles.activityId]) {
      const appearances =
        upcomingIds.filter((row: string) => row === id).length +
        pastIds.filter((row: string) => row === id).length;
      expect(appearances).toBe(1);
    }
  });
});

describe('the upcoming window', () => {
  it('defaults to today plus 61 days', async () => {
    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    expect(data.upcomingWindow.from).toBe(today());
    expect(data.upcomingWindow.through).toBe(addDays(today(), 61));
  });

  /** A far-future plan after an empty gap: the hint jumps the gap without skipping the row. */
  it('answers nextFrom with a date beyond the window, and the next window includes it', async () => {
    const far = addDays(today(), 120);
    const plan = await createPlan({
      title: 'Next summer',
      schedule: { date: far, timezone: TZ },
    });

    const initial = await dataOf(
      await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`),
    );
    expect(initial.upcomingWindow.nextFrom).toBe(far);

    const next = await dataOf(
      await plans(
        `mode=upcoming_window&tz=${encodeURIComponent(TZ)}&upcomingFrom=${far}&upcomingTo=${addDays(far, 10)}`,
      ),
    );

    expect(
      next.upcoming.flatMap((day: { items: { activityId: string }[] }) =>
        day.items.map((item) => item.activityId),
      ),
    ).toContain(plan.activityId);
  });

  it('answers null when nothing follows the window', async () => {
    await createPlan({
      title: 'Soon',
      schedule: { date: addDays(today(), 2), timezone: TZ },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));

    expect(data.upcomingWindow.nextFrom).toBeNull();
  });

  /** A recurring series contributes one row per date, through the shared expansion path. */
  it('expands a recurring series inside the window', async () => {
    const start = addDays(today(), 1);
    // The weekday is explicit because the schema requires it: a weekly rule with no `byWeekday`
    // would be the server guessing which day the user meant.
    const weekday = new Date(`${start}T12:00:00Z`).getUTCDay();
    const series = await createPlan({
      title: 'Weekly dinner',
      schedule: { date: start, timezone: TZ, time: '19:00' },
      recurrence: {
        mode: 'fixed',
        segments: [
          { freq: 'weekly', interval: 1, byWeekday: [weekday], effectiveFrom: start },
        ],
      },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const appearances = data.upcoming.flatMap(
      (day: { items: { activityId: string }[] }) =>
        day.items.filter((item) => item.activityId === series.activityId),
    );

    // 62 days of a weekly series is eight or nine dates depending on the start weekday.
    expect(appearances.length).toBeGreaterThanOrEqual(8);
    expect(new Set(data.upcoming.map((day: { date: string }) => day.date)).size).toBe(
      data.upcoming.length,
    );
  });

  it('omits the other stages from a continuation', async () => {
    const from = addDays(today(), 70);
    const data = await dataOf(
      await plans(
        `mode=upcoming_window&tz=${encodeURIComponent(TZ)}&upcomingFrom=${from}&upcomingTo=${addDays(from, 10)}`,
      ),
    );

    expect(Object.keys(data).sort()).toEqual([
      'mode',
      'upcoming',
      'upcomingWindow',
      'warnings',
    ]);
    expect(data).not.toHaveProperty('needsDate');
    expect(data).not.toHaveProperty('past');
  });

  it('400s a 63-day window', async () => {
    const from = today();
    const res = await plans(
      `mode=upcoming_window&tz=${encodeURIComponent(TZ)}&upcomingFrom=${from}&upcomingTo=${addDays(from, 62)}`,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('validation_failed');
  });
});

describe('past windows and cursors', () => {
  it('filters to the exact requested range and reports its coverage', async () => {
    const inside = await createPlan({
      title: 'Inside the grid',
      schedule: { date: addDays(today(), -10), timezone: TZ },
    });
    const outside = await createPlan({
      title: 'Outside the grid',
      schedule: { date: addDays(today(), -40), timezone: TZ },
    });

    const from = addDays(today(), -20);
    const before = addDays(today(), -1);
    const data = await dataOf(
      await plans(
        `mode=past_window&tz=${encodeURIComponent(TZ)}&pastFrom=${from}&pastBefore=${before}`,
      ),
    );

    const ids = data.past.flatMap((day: { items: { activityId: string }[] }) =>
      day.items.map((item) => item.activityId),
    );
    expect(ids).toContain(inside.activityId);
    expect(ids).not.toContain(outside.activityId);

    expect(data.pastCoverage).toMatchObject({
      requestedFrom: from,
      requestedThrough: addDays(before, -1),
      complete: true,
    });
    expect(Object.keys(data).sort()).toEqual([
      'mode',
      'past',
      'pastCoverage',
      'warnings',
    ]);
  });

  it('returns past newest first', async () => {
    await createPlan({
      title: 'Older',
      schedule: { date: addDays(today(), -10), timezone: TZ },
    });
    await createPlan({
      title: 'Newer',
      schedule: { date: addDays(today(), -3), timezone: TZ },
    });

    const data = await dataOf(await plans(`mode=initial&tz=${encodeURIComponent(TZ)}`));
    const dates = data.past.map((day: { date: string }) => day.date);

    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('400s a cursor issued for different bounds', async () => {
    const forged = Buffer.from(
      JSON.stringify({
        mode: 'past_window',
        bounds: { from: '2026-01-01', before: '2026-02-01' },
        key: 'raw',
        userId: 'usr_local_dev',
      }),
    ).toString('base64url');

    const res = await plans(
      `mode=past_window&tz=${encodeURIComponent(TZ)}&pastFrom=${addDays(today(), -20)}&pastBefore=${addDays(today(), -1)}&cursor=${forged}`,
    );

    expect(res.status).toBe(400);
  });
});
