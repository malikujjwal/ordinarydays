import type { PlansData, PlansRequest } from '@od/shared/client';
import type { WallDate } from '@od/shared/time';
import { expect, it } from 'vitest';
import { fetchStageRange } from './plansRangeFetch';

it.each([
  ['2026-10-01', '2026-10-31'],
  ['2027-03-01', '2027-03-31'],
  ['2027-09-01', '2027-09-30'],
  ['2026-12-28', '2027-01-10'],
  ['2028-02-01', '2028-02-29'],
])(
  'loads only the selected %s–%s window regardless of distance',
  async (from, through) => {
    const requests: PlansRequest[] = [];
    await fetchStageRange({
      stage: 'upcoming',
      range: { from: from as WallDate, through: through as WallDate },
      tz: 'America/New_York',
      store: { byDate: new Map(), covered: [] },
      upcomingThrough: '2026-11-04' as WallDate,
      signal: new AbortController().signal,
      pull: async (request): Promise<PlansData> => {
        requests.push(request);
        return {
          mode: 'upcoming_window',
          upcoming: [],
          upcomingWindow: { from, through, nextFrom: null },
          warnings: [],
        };
      },
      onResponse: () => {},
    });
    expect(requests).toEqual([
      {
        mode: 'upcoming_window',
        tz: 'America/New_York',
        upcomingFrom: from,
        upcomingTo: through,
      },
    ]);
  },
);
