import { describe, expect, it } from 'vitest';
import type { FetchLike, HttpClientConfig } from '../http.js';
import { createHttpClient, nullTokenProvider } from '../http.js';
import {
  continuePastWindow,
  emptyPlansStore,
  getPlans,
  isRangeCovered,
  itemsOn,
  mergePlansResponse,
  missingRanges,
  type PlansData,
  type PlansDataFor,
  type PlansItem,
  type PlansPastWindowRequest,
} from './plans.js';

/**
 * The Plans reader and its date-keyed store (P3-24, amended 2026-08-25).
 *
 * Three things are under test and only the first is ordinary:
 *
 * 1. Each mode puts its own parameters on the wire and nothing else's.
 * 2. **A Past request cannot hold a landing and a cursor at once** — asserted at compile time,
 *    because "unrepresentable" is a claim about the type, not about a runtime check.
 * 3. The store keys by **date**, so overlapping month grids store each date once and returning
 *    to a loaded month fetches nothing.
 */

const REQUEST_ID = 'req_test';

interface Call {
  url: string;
}

function makeClient(outcomes: Array<{ status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url) => {
    calls.push({ url });
    const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
    if (outcome === undefined) throw new Error('no outcome');
    return Promise.resolve({
      ok: outcome.status >= 200 && outcome.status < 300,
      status: outcome.status,
      headers: { get: () => null },
      json: () => Promise.resolve(outcome.body),
      text: () =>
        Promise.resolve(outcome.body === undefined ? '' : JSON.stringify(outcome.body)),
    });
  };

  const config: HttpClientConfig = {
    baseUrl: 'https://api.test',
    fetch,
    tokenProvider: nullTokenProvider,
    timezone: 'Europe/London',
    clientVersion: 'ios/0.1.0',
    strictResponses: true,
    sleep: () => Promise.resolve(),
    newRequestId: () => REQUEST_ID,
    onWarning: () => {},
  };
  return { client: createHttpClient(config), calls };
}

/** One agenda row, parameterised only by what the store's identity rule reads. */
function item(activityId: string, overrides: Partial<PlansItem> = {}): PlansItem {
  return {
    activityId,
    type: 'event',
    title: 'Dinner',
    status: 'scheduled',
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: false,
    capabilities: { complete: true, skip: false, snooze: false },
    participantAvatars: [],
    participantCount: 0,
    isPast: true,
    ...overrides,
  };
}

const ACT_A = 'act_01J0000000000000000000000A';
const ACT_B = 'act_01J0000000000000000000000B';

function pastWindow(
  covered: { from: string; through: string },
  days: Array<{ date: string; items: PlansItem[] }>,
  options: {
    complete?: boolean;
    nextCursor?: string;
    requested?: { from: string; through: string };
  } = {},
): PlansDataFor<'past_window'> {
  const requested = options.requested ?? covered;
  return {
    mode: 'past_window',
    past: days,
    pastCoverage: {
      requestedFrom: requested.from,
      requestedThrough: requested.through,
      coveredFrom: covered.from,
      coveredThrough: covered.through,
      complete: options.complete ?? true,
      ...(options.nextCursor === undefined ? {} : { nextCursor: options.nextCursor }),
    },
    warnings: [],
  };
}

const ok = (data: PlansData) => ({
  status: 200,
  body: { data, meta: { requestId: REQUEST_ID } },
});

describe('getPlans request shapes', () => {
  it('sends only mode and tz on the initial call', async () => {
    const { client, calls } = makeClient([
      ok({
        mode: 'initial',
        needsDate: [],
        upcoming: [],
        upcomingWindow: { from: '2026-08-26', through: '2026-10-26', nextFrom: null },
        past: [],
        pastPage: {},
        warnings: [],
      }),
    ]);

    await getPlans(client, { mode: 'initial', tz: 'Europe/London' });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/plans?mode=initial&tz=Europe%2FLondon',
    );
  });

  it('sends both Upcoming bounds', async () => {
    const { client, calls } = makeClient([
      ok({
        mode: 'upcoming_window',
        upcoming: [],
        upcomingWindow: { from: '2026-09-01', through: '2026-09-30', nextFrom: null },
        warnings: [],
      }),
    ]);

    await getPlans(client, {
      mode: 'upcoming_window',
      tz: 'UTC',
      upcomingFrom: '2026-09-01',
      upcomingTo: '2026-09-30',
    });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/plans?mode=upcoming_window&tz=UTC&upcomingFrom=2026-09-01&upcomingTo=2026-09-30',
    );
  });

  it('sends a Past landing as bounds with no cursor', async () => {
    const { client, calls } = makeClient([
      ok(pastWindow({ from: '2026-07-27', through: '2026-08-31' }, [])),
    ]);

    await getPlans(client, {
      mode: 'past_window',
      tz: 'UTC',
      pastFrom: '2026-07-27',
      pastBefore: '2026-09-01',
    });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/plans?mode=past_window&tz=UTC&pastFrom=2026-07-27&pastBefore=2026-09-01',
    );
    expect(calls[0]?.url).not.toContain('cursor');
  });

  /**
   * The continuation still puts all three fields on the wire, because the server requires the
   * cursor to have been issued for the same mode **and bounds**. The exclusivity is in the
   * shape the caller writes, not in what is sent.
   */
  it('unpacks a Past continuation back into bounds plus cursor', async () => {
    const { client, calls } = makeClient([
      ok(pastWindow({ from: '2026-07-27', through: '2026-08-31' }, [])),
    ]);

    await getPlans(client, {
      mode: 'past_window',
      tz: 'UTC',
      continuation: {
        pastFrom: '2026-07-27',
        pastBefore: '2026-09-01',
        cursor: 'cur/1',
      },
    });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/plans?mode=past_window&tz=UTC&pastFrom=2026-07-27&pastBefore=2026-09-01&cursor=cur%2F1',
    );
  });

  it('sends the older-history continuation as a cursor alone', async () => {
    const { client, calls } = makeClient([
      ok({ mode: 'past_cursor', past: [], pastPage: {}, warnings: [] }),
    ]);

    await getPlans(client, { mode: 'past_cursor', tz: 'UTC', cursor: 'c1' });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/plans?mode=past_cursor&tz=UTC&cursor=c1',
    );
    // No bounds, deliberately: this is not a bounded grid and the server would refuse them.
    expect(calls[0]?.url).not.toContain('pastFrom');
  });
});

/**
 * **The exclusivity, at compile time.**
 *
 * The amendment of 2026-08-25 requires the typing to make landing-plus-cursor unrepresentable
 * rather than merely documented. These assertions fail the build if that ever stops being true:
 * a `@ts-expect-error` that does not error is itself an error.
 */
describe('the Past request type', () => {
  it('accepts a landing, and accepts a continuation', () => {
    const landing: PlansPastWindowRequest = {
      mode: 'past_window',
      tz: 'UTC',
      pastFrom: '2026-08-01',
      pastBefore: '2026-09-01',
    };
    const continued: PlansPastWindowRequest = {
      mode: 'past_window',
      tz: 'UTC',
      continuation: {
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
        cursor: 'c1',
      },
    };

    expect(landing.mode).toBe('past_window');
    expect(continued.mode).toBe('past_window');
  });

  it('rejects a shape holding both', () => {
    // @ts-expect-error a landing may not also carry a continuation cursor: the landing arm
    // types `continuation` as `never`, and the continuation arm does the same to the bounds,
    // so an object carrying all three is assignable to neither.
    const both: PlansPastWindowRequest = {
      mode: 'past_window',
      tz: 'UTC',
      pastFrom: '2026-08-01',
      pastBefore: '2026-09-01',
      continuation: {
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
        cursor: 'c1',
      },
    };

    expect(both.mode).toBe('past_window');
  });
});

describe('continuePastWindow', () => {
  it('is undefined once the server says the grid is complete', () => {
    const request: PlansPastWindowRequest = {
      mode: 'past_window',
      tz: 'UTC',
      pastFrom: '2026-08-01',
      pastBefore: '2026-09-01',
    };

    expect(
      continuePastWindow(
        request,
        pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [], {
          complete: true,
          nextCursor: 'ignored',
        }),
      ),
    ).toBeUndefined();
  });

  it('carries the same bounds and the new cursor while it is not', () => {
    const request: PlansPastWindowRequest = {
      mode: 'past_window',
      tz: 'UTC',
      pastFrom: '2026-08-01',
      pastBefore: '2026-09-01',
    };

    expect(
      continuePastWindow(
        request,
        pastWindow({ from: '2026-08-20', through: '2026-08-31' }, [], {
          complete: false,
          nextCursor: 'c2',
          requested: { from: '2026-08-01', through: '2026-08-31' },
        }),
      ),
    ).toEqual({
      mode: 'past_window',
      tz: 'UTC',
      continuation: {
        pastFrom: '2026-08-01',
        pastBefore: '2026-09-01',
        cursor: 'c2',
      },
    });
  });
});

describe('the date-keyed store', () => {
  /**
   * The reason the store is keyed by date at all. August's 42-day grid and September's share a
   * week; keying by window bounds would hold that week twice and re-fetch it on every move.
   */
  it('stores each date once when two month grids overlap', () => {
    const shared = '2026-08-31';

    const august = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-07-27', through: shared }, [
        { date: shared, items: [item(ACT_A)] },
      ]),
    );
    const both = mergePlansResponse(
      august,
      pastWindow({ from: '2026-08-31', through: '2026-10-04' }, [
        { date: shared, items: [item(ACT_A)] },
      ]),
    );

    expect(itemsOn(both, shared)).toHaveLength(1);
    // Two overlapping grids, one merged interval — not two entries covering the same week.
    expect(both.covered).toEqual([{ from: '2026-07-27', through: '2026-10-04' }]);
  });

  it('replaces a covered date, so a deleted plan disappears', () => {
    const first = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [
        { date: '2026-08-15', items: [item(ACT_A), item(ACT_B)] },
      ]),
    );
    const second = mergePlansResponse(
      first,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [
        { date: '2026-08-15', items: [item(ACT_A)] },
      ]),
    );

    // A union would keep ACT_B for ever: a row that is gone is a row the response cannot name.
    expect(itemsOn(second, '2026-08-15').map((row) => row.activityId)).toEqual([ACT_A]);
  });

  it('removes a covered date that an authoritative response omits entirely', () => {
    const first = mergePlansResponse(emptyPlansStore, {
      mode: 'upcoming_window',
      upcoming: [{ date: '2026-08-15', items: [item(ACT_A)] }],
      upcomingWindow: { from: '2026-08-01', through: '2026-08-31', nextFrom: null },
      warnings: [],
    });
    const second = mergePlansResponse(first, {
      mode: 'upcoming_window',
      upcoming: [],
      upcomingWindow: { from: '2026-08-01', through: '2026-08-31', nextFrom: null },
      warnings: [],
    });

    expect(second.byDate.has('2026-08-15')).toBe(false);
    expect(isRangeCovered(second, '2026-08-01', '2026-08-31')).toBe(true);
  });

  it('removes the source date when a plan moves inside an authoritative interval', () => {
    const first = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [
        { date: '2026-08-15', items: [item(ACT_A)] },
      ]),
    );
    const moved = mergePlansResponse(
      first,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [
        { date: '2026-08-20', items: [item(ACT_A)] },
      ]),
    );

    expect(moved.byDate.has('2026-08-15')).toBe(false);
    expect(itemsOn(moved, '2026-08-20').map((row) => row.activityId)).toEqual([ACT_A]);
  });

  it('unions an unbounded page, so a date split across two pages keeps both halves', () => {
    const page1 = mergePlansResponse(emptyPlansStore, {
      mode: 'past_cursor',
      past: [{ date: '2026-08-15', items: [item(ACT_A)] }],
      pastPage: { nextCursor: 'c2' },
      warnings: [],
    });
    const page2 = mergePlansResponse(page1, {
      mode: 'past_cursor',
      past: [{ date: '2026-08-15', items: [item(ACT_B)] }],
      pastPage: {},
      warnings: [],
    });

    expect(page2.byDate.get('2026-08-15')?.map((row) => row.activityId)).toEqual([
      ACT_A,
      ACT_B,
    ]);
    // Re-merging the same page must not duplicate — identity is activity plus occurrence.
    const again = mergePlansResponse(page2, {
      mode: 'past_cursor',
      past: [{ date: '2026-08-15', items: [item(ACT_B)] }],
      pastPage: {},
      warnings: [],
    });
    expect(again.byDate.get('2026-08-15')).toHaveLength(2);
  });

  /**
   * Identity within a day is the activity id alone. A series expands to at most one occurrence
   * per date, so a second page repeating the same recurring row updates it in place rather than
   * appending a duplicate — and the row keeps its position while its status changes.
   */
  it('updates a repeated recurring row in place instead of duplicating it', () => {
    const page1 = mergePlansResponse(emptyPlansStore, {
      mode: 'past_cursor',
      past: [
        {
          date: '2026-08-15',
          items: [item(ACT_A, { isRecurring: true }), item(ACT_B)],
        },
      ],
      pastPage: { nextCursor: 'c2' },
      warnings: [],
    });
    const page2 = mergePlansResponse(page1, {
      mode: 'past_cursor',
      past: [
        {
          date: '2026-08-15',
          items: [item(ACT_A, { isRecurring: true, status: 'completed_occurrence' })],
        },
      ],
      pastPage: {},
      warnings: [],
    });

    const rows = itemsOn(page2, '2026-08-15');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.activityId)).toEqual([ACT_A, ACT_B]);
    expect(rows[0]?.status).toBe('completed_occurrence');
  });

  /**
   * The guard on "loaded and empty". A dense grid answers `complete: false` **with rows in
   * it**, and only the interval the server says it exhausted may be treated as known.
   */
  it('claims coverage only for what the server says it exhausted', () => {
    const store = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-20', through: '2026-08-31' }, [], {
        complete: false,
        nextCursor: 'c2',
        requested: { from: '2026-08-01', through: '2026-08-31' },
      }),
    );

    expect(isRangeCovered(store, '2026-08-20', '2026-08-31')).toBe(true);
    // Requested but not yet exhausted: unknown, not empty. No dot may be drawn as a fact.
    expect(isRangeCovered(store, '2026-08-01', '2026-08-31')).toBe(false);
    expect(missingRanges(store, '2026-08-01', '2026-08-31')).toEqual([
      { from: '2026-08-01', through: '2026-08-19' },
    ]);
  });

  it('completes the range once the continuation says so', () => {
    const partial = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-20', through: '2026-08-31' }, [], {
        complete: false,
        nextCursor: 'c2',
        requested: { from: '2026-08-01', through: '2026-08-31' },
      }),
    );
    const complete = mergePlansResponse(
      partial,
      pastWindow({ from: '2026-08-01', through: '2026-08-19' }, [], {
        complete: true,
        requested: { from: '2026-08-01', through: '2026-08-31' },
      }),
    );

    expect(isRangeCovered(complete, '2026-08-01', '2026-08-31')).toBe(true);
    expect(missingRanges(complete, '2026-08-01', '2026-08-31')).toEqual([]);
  });

  it('claims nothing at all from an unbounded past page', () => {
    const store = mergePlansResponse(emptyPlansStore, {
      mode: 'past_cursor',
      past: [{ date: '2026-08-15', items: [item(ACT_A)] }],
      pastPage: { nextCursor: 'c2' },
      warnings: [],
    });

    // It found a row on the 15th; it did not exhaust the 15th, and says so.
    expect(itemsOn(store, '2026-08-15')).toHaveLength(1);
    expect(store.covered).toEqual([]);
    expect(isRangeCovered(store, '2026-08-15', '2026-08-15')).toBe(false);
  });

  it('covers the Upcoming window an initial or windowed response exhausted', () => {
    const store = mergePlansResponse(emptyPlansStore, {
      mode: 'upcoming_window',
      upcoming: [{ date: '2026-09-02', items: [item(ACT_A, { isPast: false })] }],
      upcomingWindow: { from: '2026-09-01', through: '2026-09-30', nextFrom: null },
      warnings: [],
    });

    expect(isRangeCovered(store, '2026-09-01', '2026-09-30')).toBe(true);
    // An empty date inside a covered window is genuinely empty.
    expect(itemsOn(store, '2026-09-03')).toEqual([]);
  });

  /**
   * The navigation case the amendment names. Keying by bounds would make the second August
   * free only if the exact same bounds repeated; keying by date makes it free because the
   * dates are already there.
   */
  it('issues no refetch for August → September → August', () => {
    const august = { from: '2026-07-27', through: '2026-09-06' };
    const september = { from: '2026-08-31', through: '2026-10-04' };

    let store = mergePlansResponse(emptyPlansStore, pastWindow(august, []));
    expect(missingRanges(store, august.from, august.through)).toEqual([]);

    // September's grid overlaps August's by a week; only the new part is missing.
    expect(missingRanges(store, september.from, september.through)).toEqual([
      { from: '2026-09-07', through: '2026-10-04' },
    ]);

    store = mergePlansResponse(store, pastWindow(september, []));

    // Back to August: nothing to ask for.
    expect(missingRanges(store, august.from, august.through)).toEqual([]);
    expect(isRangeCovered(store, august.from, august.through)).toBe(true);
  });

  it('joins two adjacent grids into one range, so a query across the seam asks for nothing', () => {
    let store = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, []),
    );
    store = mergePlansResponse(
      store,
      pastWindow({ from: '2026-09-01', through: '2026-09-30' }, []),
    );

    expect(store.covered).toEqual([{ from: '2026-08-01', through: '2026-09-30' }]);
    expect(missingRanges(store, '2026-08-15', '2026-09-15')).toEqual([]);
  });

  it('is pure — the store it was given is untouched', () => {
    const before = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-01', through: '2026-08-31' }, [
        { date: '2026-08-15', items: [item(ACT_A)] },
      ]),
    );
    const snapshot = {
      dates: [...before.byDate.keys()],
      covered: JSON.stringify(before.covered),
    };

    mergePlansResponse(
      before,
      pastWindow({ from: '2026-09-01', through: '2026-09-30' }, [
        { date: '2026-09-02', items: [item(ACT_B)] },
      ]),
    );

    expect([...before.byDate.keys()]).toEqual(snapshot.dates);
    expect(JSON.stringify(before.covered)).toBe(snapshot.covered);
    expect(emptyPlansStore.byDate.size).toBe(0);
  });

  it('reports gaps on both sides of a covered island', () => {
    const store = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2026-08-10', through: '2026-08-20' }, []),
    );

    expect(missingRanges(store, '2026-08-01', '2026-08-31')).toEqual([
      { from: '2026-08-01', through: '2026-08-09' },
      { from: '2026-08-21', through: '2026-08-31' },
    ]);
  });

  it('crosses a month and a leap-year boundary without a Date object', () => {
    const store = mergePlansResponse(
      emptyPlansStore,
      pastWindow({ from: '2028-02-29', through: '2028-03-01' }, []),
    );

    expect(missingRanges(store, '2028-02-27', '2028-03-03')).toEqual([
      { from: '2028-02-27', through: '2028-02-28' },
      { from: '2028-03-02', through: '2028-03-03' },
    ]);
  });
});
