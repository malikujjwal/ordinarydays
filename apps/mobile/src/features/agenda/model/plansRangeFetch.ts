import {
  continuePastWindow,
  type DateInterval,
  missingRanges,
  type PlansData,
  type PlansDateStore,
  type PlansPastWindowRequest,
  type PlansRequest,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { WallDate } from '@od/shared/time';
import { PLANS_WINDOW_DAYS } from './plansFeed';

/**
 * The calendar navigator's window fetch, as one walk both Plans hooks share (P3-48,
 * `plans-and-lists.md` §1.3.4 rule 2): navigation selects a window; it never becomes a
 * second pagination model.
 *
 * - **Upcoming** asks for the part of the range the store has not exhausted, in bounded
 *   `upcoming_window` chunks of at most `PLANS_WINDOW_DAYS`. The requested window is independent of distance;
 *   unknown intervening dates must not be presented as known-empty gaps.
 * - **Past** asks for each unknown run as a bounded `past_window` and follows the window's
 *   own cursor until `pastCoverage.complete`; only then may the grid read an unmarked date
 *   as loaded-and-empty.
 *
 * `pull` is the platform's transport: the HTTP reader on web, the serialized sync pull on
 * native. `onResponse` lands each response wherever that platform keeps the projection.
 * `signal` stops the walk between requests; a transport that honours it may also cancel
 * the request in flight.
 */
export interface StageRangeFetch {
  readonly stage: 'upcoming' | 'past';
  readonly range: DateInterval;
  readonly tz: string;
  readonly store: PlansDateStore;
  /** The rendered Upcoming window's `through`, when one exists. */
  readonly upcomingThrough: WallDate | undefined;
  readonly signal: AbortSignal;
  readonly pull: (request: PlansRequest) => Promise<PlansData>;
  readonly onResponse: (data: PlansData) => Promise<void> | void;
}

export async function fetchStageRange(fetch: StageRangeFetch): Promise<void> {
  const { stage, range, tz, store, signal } = fetch;
  if (stage === 'upcoming') {
    for (const gap of missingRanges(store, range.from, range.through)) {
      for (
        let from = gap.from;
        from <= gap.through;
        from = addWallDays(from, PLANS_WINDOW_DAYS) as WallDate
      ) {
        if (signal.aborted) return;
        const chunkThrough = addWallDays(from, PLANS_WINDOW_DAYS - 1) as WallDate;
        const data = await fetch.pull({
          mode: 'upcoming_window',
          tz,
          upcomingFrom: from,
          upcomingTo: chunkThrough < gap.through ? chunkThrough : gap.through,
        });
        if (signal.aborted) return;
        await fetch.onResponse(data);
      }
    }
    return;
  }

  for (const gap of missingRanges(store, range.from, range.through)) {
    let request: PlansPastWindowRequest | undefined = {
      mode: 'past_window',
      tz,
      pastFrom: gap.from,
      pastBefore: addWallDays(gap.through, 1) as WallDate,
    };
    // A dense grid may come back partial: drain the window's own cursor to completion.
    while (request !== undefined) {
      if (signal.aborted) return;
      const data = await fetch.pull(request);
      if (signal.aborted) return;
      await fetch.onResponse(data);
      request =
        data.mode === 'past_window' ? continuePastWindow(request, data) : undefined;
    }
  }
}
