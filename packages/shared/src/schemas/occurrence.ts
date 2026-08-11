import { z } from 'zod';
import { hhmm, isoDate, ulidId } from './common.js';

/**
 * An occurrence override (`data-model.md` §4.5). Interface in `../types/occurrence.ts`.
 *
 * Note what is **absent**: any participant identity. An `Occurrence` says *the thing
 * happened*, not *I attended*. Completion on a shared plan is global and owner-only, and
 * adding a `userId` here would change that product decision by accident.
 */
export const occurrenceStatus = z.enum([
  'completed',
  'skipped',
  'snoozed',
  'rescheduled',
]);

/**
 * `HH:mm` same day, or a full ISO instant — the two forms `snoozedUntil` takes
 * ("until 8pm" versus "until this exact moment tomorrow").
 */
export const hhmmOrInstant = z.union([hhmm, z.iso.datetime()]);

export const occurrence = z
  .object({
    activityId: ulidId('act'),
    /** The series' nominal date. The key — not where the occurrence ends up. */
    date: isoDate,
    status: occurrenceStatus,
    snoozedUntil: hhmmOrInstant.optional(),
    overrideTime: hhmm.optional(),
    /** Where this one occurrence moved to. The series is untouched. */
    overrideDate: isoDate.optional(),
    completedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'Occurrence' });

/** Internal marker stored when one nominal occurrence moves to another wall date. */
export const occurrenceMoveMarker = z.object({
  activityId: ulidId('act'),
  destinationDate: isoDate,
  movedFrom: z.array(isoDate),
});

/** Snooze either a one-off activity or one nominal recurring occurrence. */
export const snoozeActivityInput = z
  .strictObject({
    occurrenceDate: isoDate.optional(),
    until: hhmmOrInstant,
  })
  .meta({ id: 'SnoozeActivityInput' });

/** Remove only snooze state; other occurrence overrides are left intact. */
export const unsnoozeActivityInput = z
  .strictObject({ occurrenceDate: isoDate.optional() })
  .meta({ id: 'UnsnoozeActivityInput' });

export type SnoozeActivityInput = z.infer<typeof snoozeActivityInput>;
export type UnsnoozeActivityInput = z.infer<typeof unsnoozeActivityInput>;
