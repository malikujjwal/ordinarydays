import type { z } from 'zod';
import { envelope } from '../../schemas/envelope.js';
import { type PlansDay, plansData } from '../../schemas/plans.js';
import type { HttpClient } from '../http.js';

/**
 * `GET /v1/plans` — the three-stage Plans tab (`api-contract.md` §2.2a, P3-20, P3-24).
 *
 * Two things live here: the reader, and the **date-keyed store** its responses merge into.
 * They are one file because the store's correctness depends on which mode produced a response,
 * and splitting them would let a caller merge a page under the wrong assumption.
 */

export const plansResponse = envelope(plansData);

export type PlansData = z.infer<typeof plansData>;

/** One row of a day. Derived from {@link PlansDay} so there is no second import to drift. */
export type PlansItem = PlansDay['items'][number];

/** A `YYYY-MM-DD` viewer-local wall date. Never an instant, never a `Date`. */
export type WallDate = string;

/**
 * A continuation of one bounded Past grid.
 *
 * It carries the bounds **inside itself** rather than beside a cursor, and that is the whole
 * trick behind the exclusivity below: the wire needs `pastFrom`, `pastBefore` *and* `cursor`
 * together (`api-contract.md` §2.2a — "its optional cursor must have been issued for the same
 * mode and bounds"), while a caller must never be able to hand-assemble a landing that also
 * carries a cursor. Packing the three into one value the client produces from a previous
 * response keeps the wire correct and the call site honest.
 */
export interface PastWindowContinuation {
  pastFrom: WallDate;
  /** **Exclusive.** The grid ends the day before this date. */
  pastBefore: WallDate;
  cursor: string;
}

/**
 * A Past-window request: **a landing, or a continuation of one. Never a shape that holds both.**
 *
 * This is the amendment of 2026-08-25 expressed as a type rather than a comment. The two arms
 * are mutually exclusive by construction, and the `?: never` guards are what make them so: a
 * bare union of two object types would still accept an object literal carrying keys drawn from
 * *either* member, because TypeScript's excess-property check for unions permits any property
 * that appears in any arm. With the guards, `{ pastFrom, pastBefore, continuation }` is
 * assignable to neither and fails at compile time — which is the assertion `endpoints.test.ts`
 * makes with `@ts-expect-error`.
 *
 * Why it is worth the two extra keys: a landing and a continuation are different questions. A
 * landing asks "what is in this grid"; a continuation says "keep going through the grid you
 * already gave me a cursor for". A request carrying a landing *and* a foreign cursor is a
 * request whose bounds and whose cursor disagree, and the server would answer it as
 * `validation_failed` — after the round trip.
 */
export type PlansPastWindowRequest =
  | {
      mode: 'past_window';
      tz: string;
      pastFrom: WallDate;
      pastBefore: WallDate;
      continuation?: never;
    }
  | {
      mode: 'past_window';
      tz: string;
      continuation: PastWindowContinuation;
      pastFrom?: never;
      pastBefore?: never;
    };

/**
 * The request union. One arm per mode, mirroring `plansQuery`, with the Past window split into
 * the two exclusive arms above.
 *
 * `past_cursor` is the **ordinary older-history continuation** and carries a cursor and nothing
 * else — no bounds, deliberately. It is a different thing from a `past_window` continuation and
 * the server refuses a cursor issued for one under the other, so the two are separate arms
 * rather than one shape with an optional range.
 */
export type PlansRequest =
  | { mode: 'initial'; tz: string }
  | {
      mode: 'upcoming_window';
      tz: string;
      upcomingFrom: WallDate;
      upcomingTo: WallDate;
    }
  | PlansPastWindowRequest
  | { mode: 'past_cursor'; tz: string; cursor: string };

/** The response arm that belongs to a given request mode. */
export type PlansDataFor<M extends PlansRequest['mode']> = Extract<
  PlansData,
  { mode: M }
>;

function queryFor(request: PlansRequest): string {
  const parameters: Array<[string, string]> = [
    ['mode', request.mode],
    ['tz', request.tz],
  ];

  if (request.mode === 'upcoming_window') {
    parameters.push(
      ['upcomingFrom', request.upcomingFrom],
      ['upcomingTo', request.upcomingTo],
    );
  } else if (request.mode === 'past_window') {
    // The continuation arm unpacks back into the three wire fields it was built from.
    const bounds =
      request.continuation === undefined
        ? { pastFrom: request.pastFrom, pastBefore: request.pastBefore }
        : request.continuation;
    parameters.push(['pastFrom', bounds.pastFrom], ['pastBefore', bounds.pastBefore]);
    if (request.continuation !== undefined) {
      parameters.push(['cursor', request.continuation.cursor]);
    }
  } else if (request.mode === 'past_cursor') {
    parameters.push(['cursor', request.cursor]);
  }

  return parameters
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

/**
 * One reader for all four modes, narrowing its result to the arm the mode selects.
 *
 * The response's inactive stages are **absent, not empty** (`api-contract.md` §2.2a), which is
 * what stops a continuation from erasing a stage it never asked about — a `past_cursor`
 * response cannot carry `upcoming: []` because its arm has no `upcoming` key at all. The
 * generic return type is what carries that guarantee to the caller: after `mode: 'past_cursor'`
 * there is no `upcoming` to read, so there is nothing to accidentally merge.
 */
export function getPlans<R extends PlansRequest>(
  client: HttpClient,
  request: R,
  signal?: AbortSignal,
): Promise<PlansDataFor<R['mode']>> {
  return client
    .request({
      method: 'GET',
      path: `/v1/plans?${queryFor(request)}`,
      schema: plansResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as PlansDataFor<R['mode']>);
}

/**
 * Builds the continuation for the grid a `past_window` response has not finished.
 *
 * Returns `undefined` when coverage is complete — which is also the caller's loop condition, so
 * "is there more of this grid" and "how do I ask for it" are one question with one answer
 * rather than two checks that can disagree.
 */
export function continuePastWindow(
  request: PlansPastWindowRequest,
  data: PlansDataFor<'past_window'>,
): PlansPastWindowRequest | undefined {
  const { nextCursor } = data.pastCoverage;
  if (data.pastCoverage.complete || nextCursor === undefined) return undefined;

  const bounds =
    request.continuation === undefined
      ? { pastFrom: request.pastFrom, pastBefore: request.pastBefore }
      : request.continuation;

  return {
    mode: 'past_window',
    tz: request.tz,
    continuation: {
      pastFrom: bounds.pastFrom,
      pastBefore: bounds.pastBefore,
      cursor: nextCursor,
    },
  };
}

/* ------------------------------------------------------------------------------------------ *
 * The date-keyed store
 * ------------------------------------------------------------------------------------------ */

/**
 * ## Why responses are keyed by date rather than by the window that fetched them
 *
 * A month grid renders up to 42 days once adjacent-month cells are included, so consecutive
 * months **overlap** — August's grid and September's share a week. Caching by window bounds
 * would store that week twice, re-fetch it on every move, and make "August → September →
 * August" free only when the exact same bounds repeated. Keying by date stores each date once
 * and makes the second August free because the dates are already there, not because the request
 * happened to match.
 *
 * The same store answers the question P3-47's calendar depends on: **which ranges have actually
 * been loaded**. A date with no rows is ambiguous on its own — nothing planned, or nothing
 * fetched — and the calendar's no-dot-means-no-claim rule needs the difference. That is what
 * {@link isRangeCovered} is for, and why coverage is tracked separately from rows.
 *
 * ## What is deliberately not in here
 *
 * `needsDate` rows are **undated** — that is what the stage means — so they have no key in a
 * date store and are left to the caller's own state. Putting them under a synthetic key would
 * invent a date the product spent a whole stage avoiding.
 */
export interface PlansDateStore {
  /** Rows by viewer-local wall date. A date absent from the map has no rows *known*. */
  readonly byDate: ReadonlyMap<WallDate, readonly PlansItem[]>;
  /**
   * Closed `[from, through]` intervals that have been **exhausted**, normalised and merged.
   * Only inside one of these may an empty date be read as loaded-and-empty.
   */
  readonly covered: readonly DateInterval[];
}

/** A closed, inclusive interval of wall dates. */
export interface DateInterval {
  from: WallDate;
  through: WallDate;
}

export const emptyPlansStore: PlansDateStore = { byDate: new Map(), covered: [] };

/**
 * Whole UTC days since the epoch for a `YYYY-MM-DD`.
 *
 * `Date.UTC` is a static that returns a number; **no `Date` object is constructed**, here or
 * anywhere else in this file (`coding-standards.md` §4.4). Used only for adjacency — deciding
 * whether two intervals touch — because containment compares the strings directly, which is
 * correct for zero-padded ISO dates and needs no arithmetic at all.
 */
function wallDay(value: WallDate): number {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** Sorts, then merges every overlapping **or adjacent** pair, so two touching months become one. */
function normalise(intervals: readonly DateInterval[]): DateInterval[] {
  const sorted = [...intervals].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  const merged: DateInterval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && wallDay(interval.from) <= wallDay(last.through) + 1) {
      // Adjacent counts: a grid ending on the 31st and one starting on the 1st are one range,
      // and leaving them apart would make a query spanning the seam ask for what it already has.
      if (interval.through > last.through) last.through = interval.through;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** The rows known for one date. Empty for a date with none — see {@link isRangeCovered}. */
export function itemsOn(store: PlansDateStore, date: WallDate): readonly PlansItem[] {
  return store.byDate.get(date) ?? [];
}

/**
 * Whether every date in `[from, through]` has been exhausted by some response.
 *
 * This is the guard on "loaded and empty". `false` means *unknown*, not *empty*, and the
 * calendar must fetch before it may draw the absence of a dot as a fact.
 */
export function isRangeCovered(
  store: PlansDateStore,
  from: WallDate,
  through: WallDate,
): boolean {
  return store.covered.some(
    (interval) => interval.from <= from && interval.through >= through,
  );
}

/**
 * The sub-ranges of `[from, through]` that are still unknown, in ascending order.
 *
 * What the navigator fetches. Empty means the grid is fully loaded and no request is issued —
 * which is what makes returning to August free. Ranges are clipped to the request, so moving
 * one week forward asks for one week, not another 42 days.
 */
export function missingRanges(
  store: PlansDateStore,
  from: WallDate,
  through: WallDate,
): DateInterval[] {
  if (from > through) return [];

  const gaps: DateInterval[] = [];
  const end = wallDay(through);
  let cursor = wallDay(from);

  for (const interval of store.covered) {
    const intervalFrom = wallDay(interval.from);
    const intervalThrough = wallDay(interval.through);
    if (intervalThrough < cursor) continue;
    if (intervalFrom > end) break;
    if (intervalFrom > cursor) {
      gaps.push({ from: wallDate(cursor), through: wallDate(intervalFrom - 1) });
    }
    cursor = Math.max(cursor, intervalThrough + 1);
    if (cursor > end) return gaps;
  }

  if (cursor <= end) gaps.push({ from: wallDate(cursor), through });
  return gaps;
}

/** The inverse of {@link wallDay}, for the gap endpoints that fall between covered ranges. */
function wallDate(day: number): WallDate {
  return isoFromUtcMillis(day * 86_400_000);
}

/**
 * `YYYY-MM-DD` from a UTC millisecond count, **without constructing a `Date`**.
 *
 * Howard Hinnant's civil-from-days algorithm: pure integer arithmetic, no clock, no locale, no
 * `Date` object (`coding-standards.md` §4.4). Nothing in this file reads the current time.
 */
function isoFromUtcMillis(millis: number): WallDate {
  const days = Math.floor(millis / 86_400_000) + 719_468;
  const era = Math.floor(days / 146_097);
  const dayOfEra = days - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * One item's identity **within a date bucket**, which is the only scope this is used in.
 *
 * The activity id alone is enough, and deliberately so. A recurring series expands to at most
 * one occurrence per date — the `Occurrence` entity is keyed by date (`data-model.md` §6) — so
 * two rows under one `plansDay` cannot name the same series. Adding the occurrence date would
 * be a second key doing no work, and it would spread ADR-053's wire key into a file that has no
 * business naming it: `packages/shared/src/types/scopeGuard.test.ts` holds that line, and the
 * right answer to it here was to need one key rather than to ask for an allowlist entry.
 */
function identity(item: PlansItem): string {
  return item.activityId;
}

/**
 * Merges one response into the store. **Pure** — the argument is never mutated and a new store
 * is returned.
 *
 * ## Two merge rules, chosen by whether the response was exhaustive
 *
 * A **bounded** response (`upcoming_window`, or the covered part of a `past_window`) is
 * authoritative for the dates it covers, so those dates are **replaced**. That is what lets a
 * deleted plan disappear: a union would keep it for ever, because a row that is gone is a row
 * the response cannot mention.
 *
 * An **unbounded** page (`initial`'s past, `past_cursor`) is one page of a descending scan and
 * may split a single date across two pages, so its dates are **unioned** by identity. Replacing
 * there would throw away the half of a date the previous page delivered; appending blindly would
 * duplicate every row when the same page is fetched twice.
 *
 * ## Coverage
 *
 * Only `pastCoverage.coveredFrom … coveredThrough` and `upcomingWindow.from … through` become
 * covered intervals. An unbounded past page claims **nothing**: it says what it found, not that
 * it exhausted a range, so no date it touched may later be read as loaded-and-empty on its
 * account. `pastCoverage.complete` is the server's word for whether the *requested* grid is
 * finished, and {@link continuePastWindow} is what acts on it — a partial response still
 * contributes the interval it did exhaust, and nothing beyond it.
 */
export function mergePlansResponse(
  store: PlansDateStore,
  data: PlansData,
): PlansDateStore {
  const byDate = new Map(store.byDate);
  const covered: DateInterval[] = [...store.covered];

  const authoritative: DateInterval[] = [];
  const exhaustive: PlansDay[] = [];
  const partial: PlansDay[] = [];

  if (data.mode === 'initial' || data.mode === 'upcoming_window') {
    authoritative.push({
      from: data.upcomingWindow.from,
      through: data.upcomingWindow.through,
    });
    exhaustive.push(...data.upcoming);
  }

  if (data.mode === 'past_window') {
    authoritative.push({
      from: data.pastCoverage.coveredFrom,
      through: data.pastCoverage.coveredThrough,
    });
    // A row outside the exhausted interval is still a real row, but it arrived from a range
    // this response did not finish, so it merges on the unbounded terms.
    for (const day of data.past) {
      const inside =
        day.date >= data.pastCoverage.coveredFrom &&
        day.date <= data.pastCoverage.coveredThrough;
      (inside ? exhaustive : partial).push(day);
    }
  }

  if (data.mode === 'initial' || data.mode === 'past_cursor') partial.push(...data.past);

  // An exhaustive interval speaks for empty dates as well as returned ones. Clear every
  // materialized date it covers before applying the response, otherwise a plan whose last
  // row was deleted or moved remains in the store forever: the authoritative response has
  // no day entry through which to replace it.
  for (const date of byDate.keys()) {
    if (authoritative.some(({ from, through }) => date >= from && date <= through)) {
      byDate.delete(date);
    }
  }

  for (const day of exhaustive) byDate.set(day.date, [...day.items]);

  for (const day of partial) {
    const existing = byDate.get(day.date) ?? [];
    const merged = [...existing];
    const positions = new Map(merged.map((item, index) => [identity(item), index]));
    for (const item of day.items) {
      const at = positions.get(identity(item));
      if (at === undefined) {
        positions.set(identity(item), merged.length);
        merged.push(item);
      } else {
        // The newer copy wins in place, so a status change lands without reordering the day.
        merged[at] = item;
      }
    }
    byDate.set(day.date, merged);
  }

  covered.push(...authoritative);
  return { byDate, covered: normalise(covered) };
}
