import { z } from 'zod';
import { MAX_AGENDA_DAYS, MAX_NEEDS_DATE_ROWS } from '../constants.js';
import { agendaItem, agendaWarning } from './agenda.js';
import { ianaTimezone, isoDate } from './common.js';

/**
 * `GET /v1/plans` — the three-stage Plans tab (`api-contract.md` §2.2a, §P3-20).
 *
 * ## Why both halves are discriminated unions
 *
 * The endpoint originally launched all four Query streams on every request, so scrolling one
 * stage paid for all three. `mode` now selects one arm on the way in and one on the way out,
 * and the two are the same decision: a continuation that reads only past `#S` must not be
 * able to *answer* with `upcoming: []`, because a client merging that response would erase a
 * stage it never asked about. **Inactive stage keys are absent, not empty** — the amendment of
 * 2026-08-25 is as much about the response as the query.
 */

/** Days between two `YYYY-MM-DD` wall dates, as whole UTC days. Never a local clock. */
function wallDay(value: string): number {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** An opaque continuation. Its bounds and mode are sealed inside it, never re-sent. */
const cursor = z.string().min(1).max(2000);

export const plansMode = z.enum([
  'initial',
  'upcoming_window',
  'past_window',
  'past_cursor',
]);

/**
 * The request. **Strict on every arm**, so a field belonging to another mode is a named `400`
 * rather than a silently ignored parameter that launches streams the caller did not ask for.
 */
export const plansQuery = z
  .discriminatedUnion('mode', [
    z
      .strictObject({ mode: z.literal('initial'), tz: ianaTimezone })
      .meta({ id: 'PlansInitialQuery' }),
    z
      .strictObject({
        mode: z.literal('upcoming_window'),
        tz: ianaTimezone,
        upcomingFrom: isoDate,
        upcomingTo: isoDate,
      })
      .meta({ id: 'PlansUpcomingWindowQuery' }),
    z
      .strictObject({
        mode: z.literal('past_window'),
        tz: ianaTimezone,
        pastFrom: isoDate,
        /** **Exclusive.** The calendar's visible grid ends the day before this date. */
        pastBefore: isoDate,
        cursor: cursor.optional(),
      })
      .meta({ id: 'PlansPastWindowQuery' }),
    z
      .strictObject({ mode: z.literal('past_cursor'), tz: ianaTimezone, cursor })
      .meta({ id: 'PlansPastCursorQuery' }),
  ])
  .superRefine((value, context) => {
    if (value.mode === 'upcoming_window') {
      const days = wallDay(value.upcomingTo) - wallDay(value.upcomingFrom) + 1;
      if (days < 1) {
        context.addIssue({
          code: 'custom',
          path: ['upcomingTo'],
          message: "Expected 'upcomingTo' to be on or after 'upcomingFrom'",
        });
      } else if (days > MAX_AGENDA_DAYS) {
        context.addIssue({
          code: 'custom',
          path: ['upcomingTo'],
          message: `Upcoming windows cannot exceed ${MAX_AGENDA_DAYS} days`,
        });
      }
    }

    if (value.mode === 'past_window') {
      /**
       * Exclusive, so a one-day grid is `pastFrom === pastBefore - 1` and an empty range is
       * `pastFrom === pastBefore`. The inclusive span is measured the same way the Upcoming
       * window is, against the same cap, because the caller is the same calendar and a 42-day
       * visible grid has to fit comfortably inside it.
       */
      const days = wallDay(value.pastBefore) - wallDay(value.pastFrom);
      if (days < 1) {
        context.addIssue({
          code: 'custom',
          path: ['pastBefore'],
          message: "Expected 'pastBefore' to be after 'pastFrom'",
        });
      } else if (days > MAX_AGENDA_DAYS) {
        context.addIssue({
          code: 'custom',
          path: ['pastBefore'],
          message: `Past windows cannot exceed ${MAX_AGENDA_DAYS} days`,
        });
      }
    }
  });

export type PlansQuery = z.infer<typeof plansQuery>;
export type PlansMode = z.infer<typeof plansMode>;

/**
 * One RSVP group: the full size, plus enough names to render the sentence.
 *
 * `names` carries at most the first two, because the row reads
 * `Alice interested · Ben hasn't replied` and a count alone cannot produce that. The keys are
 * the **undated** vocabulary — this field appears only on needs-a-date rows — and introduce no
 * stored enum member: `interested` maps stored `going`, `pass` maps `declined`
 * (`data-model.md` §7.1).
 */
export const rsvpGroup = z.strictObject({
  count: z.number().int().nonnegative(),
  names: z.array(z.string().min(1)).max(2),
});

export const rsvpSummary = z
  .strictObject({
    interested: rsvpGroup,
    maybe: rsvpGroup,
    pass: rsvpGroup,
    pending: rsvpGroup,
  })
  .meta({ id: 'RsvpSummary' });

/**
 * A needs-a-date row: an `AgendaItem` plus the three fields the stage renders.
 *
 * `lastActivityAt` is not decoration. `#P` sorts on it and GSI1 is eventually consistent, so a
 * client that refetched after posting an update could read a projection older than its own
 * mutation response; carrying the value lets P3-35 merge it monotonically.
 */
export const needsDateItem = agendaItem
  .extend({
    lastActivityAt: z.iso.datetime(),
    rsvpSummary,
    /** Drives the row's third line (`2 dates suggested`). The suggestions are not inlined. */
    suggestionCount: z.number().int().nonnegative(),
  })
  .meta({ id: 'NeedsDateItem' });

/** One date heading and the rows under it, in viewer-local terms. */
export const plansDay = z
  .strictObject({ date: isoDate, items: z.array(agendaItem) })
  .meta({ id: 'PlansDay' });

/**
 * `nextFrom` is the earliest one-off **or** recurring date after `through`, so an Upcoming
 * scroll may jump an empty gap without ever skipping a row. `null` means neither source has a
 * later item — not that the answer is unknown.
 */
export const upcomingWindow = z
  .strictObject({
    from: isoDate,
    through: isoDate,
    nextFrom: isoDate.nullable(),
  })
  .meta({ id: 'UpcomingWindow' });

export const pastPage = z
  .strictObject({ nextCursor: cursor.optional() })
  .meta({ id: 'PastPage' });

/**
 * What a bounded past window actually **exhausted**, which is not the same as what returned
 * rows.
 *
 * The calendar may only render a date as loaded-and-empty once the interval containing it is
 * complete. A dense 42-day grid can therefore answer `complete: false` with rows in it; the
 * client repeats the same bounds with `nextCursor` until it is told the grid is done.
 */
export const pastCoverage = z
  .strictObject({
    requestedFrom: isoDate,
    requestedThrough: isoDate,
    coveredFrom: isoDate,
    coveredThrough: isoDate,
    complete: z.boolean(),
    nextCursor: cursor.optional(),
  })
  .meta({ id: 'PastCoverage' });

/**
 * `needs_date_limit_exceeded` means the response holds the first {@link MAX_NEEDS_DATE_ROWS}
 * undated plans. It is a **diagnostic**, never a badge input: §1.3.2 forbids the stage
 * carrying a number a client could bind to chrome, and a warning is not a count.
 */
export const plansWarning = z.union([
  agendaWarning,
  z.literal('needs_date_limit_exceeded'),
]);

const warnings = z.array(plansWarning);

/**
 * The response, one arm per mode.
 *
 * Note what is **not** here, in any arm: no stage-level `count`, `total`, `unread` or `badge`.
 * The nested RSVP counts and `suggestionCount` describe one row and are content; a stage total
 * would be a backlog number, and Needs a date is a place to look rather than a queue to clear
 * (`plans-and-lists.md` §1.3.2). A schema test asserts their absence, because the cheapest
 * moment to stop a badge existing is before anything can read one.
 */
export const plansData = z
  .discriminatedUnion('mode', [
    z
      .strictObject({
        mode: z.literal('initial'),
        needsDate: z.array(needsDateItem).max(MAX_NEEDS_DATE_ROWS),
        upcoming: z.array(plansDay),
        upcomingWindow,
        past: z.array(plansDay),
        pastPage,
        warnings,
      })
      .meta({ id: 'PlansInitialData' }),
    z
      .strictObject({
        mode: z.literal('upcoming_window'),
        upcoming: z.array(plansDay),
        upcomingWindow,
        warnings,
      })
      .meta({ id: 'PlansUpcomingWindowData' }),
    z
      .strictObject({
        mode: z.literal('past_window'),
        past: z.array(plansDay),
        pastCoverage,
        warnings,
      })
      .meta({ id: 'PlansPastWindowData' }),
    z
      .strictObject({
        mode: z.literal('past_cursor'),
        past: z.array(plansDay),
        pastPage,
        warnings,
      })
      .meta({ id: 'PlansPastCursorData' }),
  ])
  .meta({ id: 'PlansData' });

export type RsvpGroup = z.infer<typeof rsvpGroup>;
export type RsvpSummary = z.infer<typeof rsvpSummary>;
export type NeedsDateItem = z.infer<typeof needsDateItem>;
export type PlansDay = z.infer<typeof plansDay>;
export type UpcomingWindow = z.infer<typeof upcomingWindow>;
export type PastPage = z.infer<typeof pastPage>;
export type PastCoverage = z.infer<typeof pastCoverage>;
export type PlansWarning = z.infer<typeof plansWarning>;
export type PlansData = z.infer<typeof plansData>;

/** The cursor's sealed contents. Never sent by a client; never re-derived from the query. */
export const plansPastCursorPayload = z.strictObject({
  /** Which mode issued it, so a `past_window` cursor cannot continue `past_cursor`. */
  mode: z.enum(['initial', 'past_window', 'past_cursor']),
  /** Present only for `past_window`, pinning the bounds it was issued against. */
  bounds: z.strictObject({ from: isoDate, before: isoDate }).optional(),
  /** The raw DynamoDB continuation key, as the repository issued it. */
  key: z.string().min(1),
  /** The viewer-local date the bounded scan had exhausted down to when it stopped. */
  coveredThrough: isoDate.optional(),
  userId: z.string().min(1),
});

export type PlansPastCursorPayload = z.infer<typeof plansPastCursorPayload>;
