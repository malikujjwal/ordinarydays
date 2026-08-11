import { z } from 'zod';
import { activity } from './activity.js';
import { hhmm, ianaTimezone, isoDate } from './common.js';

/** The sole schedule mutation body (`POST /v1/activities/:id/schedule`). */
export const scheduleActivityInput = z
  .strictObject({
    date: isoDate.nullable(),
    time: hhmm.optional(),
    endTime: hhmm.optional(),
    /** Optional on the wire so `X-Client-Timezone` can provide the documented fallback. */
    timezone: ianaTimezone.optional(),
    occurrenceDate: isoDate.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.date === null && value.time !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['time'], message: 'time requires date' });
    }
    if (value.date === null && value.endTime !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime requires date',
      });
    }
    if (value.endTime !== undefined && value.time === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime requires time',
      });
    }
    if (
      value.time !== undefined &&
      value.endTime !== undefined &&
      value.endTime <= value.time
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'endTime must be after time on the same day',
      });
    }
  })
  .meta({ id: 'ScheduleActivityInput' });

export type ScheduleActivityInput = z.infer<typeof scheduleActivityInput>;

export const scheduleActivityResult = z
  .object({
    activity,
    rsvpReset: z.literal(true).optional(),
    reminderOffsetsNormalized: z.literal(true).optional(),
  })
  .meta({ id: 'ScheduleActivityResult' });

export type ScheduleActivityResult = z.infer<typeof scheduleActivityResult>;
