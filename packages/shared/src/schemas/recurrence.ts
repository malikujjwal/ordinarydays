import { z } from 'zod';
import { MAX_RECURRENCE_SEGMENTS } from '../constants.js';
import { hhmm, isoDate } from './common.js';

/**
 * The segmented recurrence rule (`data-model.md` §4.2).
 *
 * The interface is in `../types/recurrence.ts`; `recurrence.test.ts` pins the two together.
 */

export const recurrenceMode = z.enum(['fixed', 'after_completion']);

export const recurrenceFreq = z.enum([
  'daily',
  'weekly',
  'monthly',
  'yearly',
  'interval_days',
  'weekdays',
  'custom',
]);

/** `0` = Sunday. */
export const weekday = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

/**
 * A literal union rather than `z.number().min(1).max(12)`, for the same reason as
 * {@link weekday}: the inferred type has to be `1 | 2 | … | 12` to match the interface, and
 * a range check infers plain `number`. Casting the range to the literal union would be a
 * lie the compiler cannot check — the union is longer to write and true.
 */
export const monthNumber = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
  z.literal(8),
  z.literal(9),
  z.literal(10),
  z.literal(11),
  z.literal(12),
]);

export const recurrenceSegment = z.object({
  freq: recurrenceFreq,
  interval: z.number().int().positive().max(365).optional(),
  byWeekday: z.array(weekday).min(1).max(7).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).min(1).max(31).optional(),
  byMonth: z.array(monthNumber).min(1).max(12).optional(),
  rrule: z.string().min(1).max(500).optional(),
  effectiveFrom: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
});

/**
 * `segments` is 1–20 and **strictly ascending by `effectiveFrom`**.
 *
 * The ordering is asserted here because nothing else in Phase 1 enforces it and the
 * expansion engine (P2-01) will assume it: a segment list that is out of order silently
 * makes an older rule shadow a newer one, and the symptom is an occurrence on the wrong day
 * months later. Cheaper to reject at the boundary than to debug from a bug report.
 */
export const recurrence = z
  .object({
    mode: recurrenceMode,
    segments: z.array(recurrenceSegment).min(1).max(MAX_RECURRENCE_SEGMENTS),
    endDate: isoDate.optional(),
    count: z.number().int().positive().max(1000).optional(),
  })
  .refine(
    (value) =>
      value.segments.every(
        (segment, index) =>
          index === 0 ||
          // biome-ignore lint/style/noNonNullAssertion: index > 0, so the predecessor exists.
          segment.effectiveFrom > value.segments[index - 1]!.effectiveFrom,
      ),
    {
      message: 'Recurrence segments must be ordered by effectiveFrom, strictly ascending',
      path: ['segments'],
    },
  )
  .meta({ id: 'Recurrence' });
