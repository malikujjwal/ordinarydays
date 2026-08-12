import { z } from 'zod';
import { MAX_RECURRENCE_SEGMENTS } from '../constants.js';
import type { Recurrence, RecurrenceSegment } from '../types/recurrence.js';
import { hhmm, isoDate } from './common.js';

/** The stored segmented recurrence contract (`data-model.md` §4.2, P2-04). */

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

/** `0` = Sunday. A literal union keeps the inferred type equal to `Weekday`. */
export const weekday = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]);

/** A literal union keeps the inferred type equal to `MonthNumber`. */
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

const segmentShape = z.strictObject({
  freq: recurrenceFreq,
  /** Used by interval_days, weekly and monthly rules. */
  interval: z.number().int().positive().max(365).optional(),
  byWeekday: z.array(weekday).min(1).max(7).optional(),
  byMonthDay: z.array(z.number().int().min(1).max(31)).length(1).optional(),
  byMonth: z.array(monthNumber).length(1).optional(),
  rrule: z.string().min(1).max(500).optional(),
  effectiveFrom: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
});

export const recurrenceSegment = segmentShape
  .superRefine((segment, ctx) => {
    if (segment.freq === 'custom') {
      ctx.addIssue({
        code: 'custom',
        message: 'Custom recurrence is not available until Phase 9.',
        path: ['freq'],
      });
    }
    if (segment.freq === 'weekly' && segment.byWeekday === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Weekly recurrence requires at least one weekday.',
        path: ['byWeekday'],
      });
    }
    if (segment.freq === 'monthly' && segment.byMonthDay === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Monthly recurrence requires one month-day anchor.',
        path: ['byMonthDay'],
      });
    }
    if (segment.freq === 'yearly') {
      const hasMonth = segment.byMonth !== undefined;
      const hasMonthDay = segment.byMonthDay !== undefined;
      if (hasMonth !== hasMonthDay) {
        ctx.addIssue({
          code: 'custom',
          message: 'Yearly recurrence requires both anchors, or neither.',
          path: [hasMonth ? 'byMonthDay' : 'byMonth'],
        });
      }
    }
    if (segment.freq === 'interval_days' && segment.interval === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Every-X-days recurrence requires an interval from 2 to 365.',
        path: ['interval'],
      });
    }
  })
  .transform(
    (segment): RecurrenceSegment => ({
      freq:
        segment.freq === 'interval_days' && segment.interval === 1
          ? 'daily'
          : segment.freq,
      ...(segment.interval === undefined ? {} : { interval: segment.interval }),
      ...(segment.byWeekday === undefined ? {} : { byWeekday: segment.byWeekday }),
      ...(segment.byMonthDay === undefined ? {} : { byMonthDay: segment.byMonthDay }),
      ...(segment.byMonth === undefined ? {} : { byMonth: segment.byMonth }),
      ...(segment.rrule === undefined ? {} : { rrule: segment.rrule }),
      effectiveFrom: segment.effectiveFrom,
      ...(segment.time === undefined ? {} : { time: segment.time }),
      ...(segment.endTime === undefined ? {} : { endTime: segment.endTime }),
    }),
  );

const recurrenceShape = z.strictObject({
  mode: recurrenceMode,
  segments: z
    .array(recurrenceSegment)
    .min(1)
    .max(
      MAX_RECURRENCE_SEGMENTS,
      `A recurrence can have at most ${MAX_RECURRENCE_SEGMENTS} segments. End this series and start a new one.`,
    ),
  endDate: isoDate.optional(),
  count: z.number().int().min(1).max(999).optional(),
});

export const recurrence = recurrenceShape
  .superRefine((value, ctx) => {
    if (value.mode !== 'fixed') {
      ctx.addIssue({
        code: 'custom',
        message: 'Completion-relative recurrence is not available until Phase 9.',
        path: ['mode'],
      });
    }

    value.segments.forEach((segment, index) => {
      const previous = value.segments[index - 1];
      if (previous !== undefined && segment.effectiveFrom <= previous.effectiveFrom) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Recurrence segments must be ordered by effectiveFrom, strictly ascending.',
          path: ['segments', index, 'effectiveFrom'],
        });
      }
    });

    const first = value.segments[0];
    if (
      first !== undefined &&
      value.endDate !== undefined &&
      value.endDate < first.effectiveFrom
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'The recurrence end date cannot be before its first segment.',
        path: ['endDate'],
      });
    }
  })
  .transform(
    (value): Recurrence => ({
      mode: value.mode,
      segments: value.segments,
      ...(value.endDate === undefined ? {} : { endDate: value.endDate }),
      ...(value.count === undefined ? {} : { count: value.count }),
    }),
  )
  .meta({ id: 'Recurrence' });

export type CreateRecurrence = Omit<Recurrence, 'segments'> & {
  segments: [RecurrenceSegment];
};

/** Creation is the only recurrence input whose segment list is exactly one at the type level. */
export const createRecurrence = recurrence
  .refine((value) => value.segments.length === 1, {
    message: 'A new recurrence must contain exactly one segment.',
    path: ['segments'],
  })
  .transform((value): CreateRecurrence => {
    const segment = value.segments[0];
    if (segment === undefined) {
      throw new Error('createRecurrence refinement admitted an empty segment list.');
    }
    return { ...value, segments: [segment] };
  });
