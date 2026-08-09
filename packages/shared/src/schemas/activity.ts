import { z } from 'zod';
import {
  MAX_ADDRESS_LEN,
  MAX_FREE_TEXT_LEN,
  MAX_INGREDIENTS,
  MAX_NOTES_LEN,
  MAX_PARTICIPANTS,
  MAX_REMINDERS_PER_USER_PER_ACTIVITY,
  MAX_TITLE_LEN,
} from '../constants.js';
import { cents, hhmm, ianaTimezone, isoDate, ulidId, userId } from './common.js';
import { recurrence } from './recurrence.js';
import { reminderInput } from './reminder.js';

/**
 * The Activity, its `details` union, and the create/patch inputs
 * (`data-model.md` §4.1/§4.4, `api-contract.md` §2.3, `activities.md` §3–§4).
 *
 * The interface is in `../types/activity.ts`; `activity.test.ts` pins the two together.
 *
 * ## The rule this file exists to enforce
 *
 * **`objectKind` and `type` are both required, and neither is ever inferred.** There is no
 * default, no title-based classification and no recovery path — omitting either, or sending
 * an incompatible pair, is `validation_failed`. The chooser or a labelled contextual entry
 * point fixes the pair before the request is built (`CLAUDE.md` rule 2, ADR-046). Do not add
 * a fallback here, in a handler, in the API client or in a form store.
 */

const freeText = z.string().trim().max(MAX_FREE_TEXT_LEN);
const title = z
  .string()
  .trim()
  .min(1, 'A title is required')
  .max(MAX_TITLE_LEN, `A title is at most ${MAX_TITLE_LEN} characters`);

export const activitySchedule = z.object({
  date: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
  timezone: ianaTimezone,
  scheduledAtUtc: z.iso.datetime().optional(),
  endAtUtc: z.iso.datetime().optional(),
});

export const activityLocation = z.object({
  label: freeText,
  address: z.string().trim().max(MAX_ADDRESS_LEN).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  mapUrl: z.url().optional(),
});

export const mealIngredient = z.object({
  name: freeText.min(1),
  quantity: freeText.optional(),
  addedToListId: ulidId('lst').optional(),
});

export const outingReservation = z.object({
  name: freeText.optional(),
  time: hhmm.optional(),
  partySize: z.number().int().positive().max(100).optional(),
  reference: freeText.optional(),
});

/**
 * Type-specific fields, discriminated on `kind` (`data-model.md` §4.4).
 *
 * Each arm names only its own fields, so a body carrying `season` on a meal fails rather
 * than being silently dropped.
 */
export const activityDetails = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task') }),
  z.object({
    kind: z.literal('meal'),
    mealSlot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
    ingredients: z.array(mealIngredient).max(MAX_INGREDIENTS).optional(),
    recipeUrl: z.url().optional(),
  }),
  z.object({
    kind: z.literal('watch'),
    mediaTitle: title,
    mediaKind: z.enum(['movie', 'show']).optional(),
    season: z.number().int().min(0).max(1000).optional(),
    episode: z.number().int().min(0).max(10000).optional(),
    episodeTitle: freeText.optional(),
    service: freeText.optional(),
  }),
  z.object({
    kind: z.literal('event'),
    description: z.string().trim().max(MAX_NOTES_LEN).optional(),
    priceCents: cents.nonnegative('A price cannot be negative').optional(),
    currency: z.string().length(3).optional(),
    ticketUrl: z.url().optional(),
    organiser: freeText.optional(),
  }),
  z.object({
    kind: z.literal('outing'),
    placeName: freeText.optional(),
    reservation: outingReservation.optional(),
  }),
  z.object({ kind: z.literal('custom'), shortcutId: ulidId('sct').optional() }),
]);

/**
 * `time` requires `date`; `endTime` requires `time` and must be after it
 * (`activities.md` §3 rule 4).
 *
 * Shared by the stored shape and both inputs, so the three cannot drift into disagreeing
 * about what a well-formed schedule is.
 */
function checkSchedule(
  schedule: { date?: unknown; time?: string | undefined; endTime?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (schedule.time === undefined && schedule.endTime !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'An end time needs a start time',
      path: ['schedule', 'endTime'],
    });
  }
  if (
    schedule.time !== undefined &&
    schedule.endTime !== undefined &&
    schedule.endTime <= schedule.time
  ) {
    ctx.addIssue({
      code: 'custom',
      message: 'The end time must be after the start time',
      path: ['schedule', 'endTime'],
    });
  }
}

/** `details.kind` must equal `type`. The single most useful validation in the product. */
function checkDetailsMatchType(
  value: { type: string; details?: { kind: string } | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.details !== undefined && value.details.kind !== value.type) {
    ctx.addIssue({
      code: 'custom',
      message: `details.kind must be "${value.type}" to match the activity type`,
      path: ['details', 'kind'],
    });
  }
}

const activityBaseShape = {
  activityId: ulidId('act'),
  ownerId: userId,
  status: z.enum(['saved', 'scheduled', 'completed', 'skipped', 'cancelled']),
  title,
  notes: z.string().max(MAX_NOTES_LEN).optional(),
  schedule: activitySchedule.optional(),
  recurrence: recurrence.optional(),
  location: activityLocation.optional(),
  parentActivityId: ulidId('act').optional(),
  listItemId: ulidId('itm').optional(),
  listId: ulidId('lst').optional(),
  sourceUrl: z.url().optional(),
  primaryAttachmentId: ulidId('att').optional(),
  participantCount: z.number().int().nonnegative(),
  childCount: z.number().int().nonnegative(),
  expenseTotalCents: z.number().int(),
  visibility: z.enum(['private', 'shared']),
  details: activityDetails,
  completedAt: z.iso.datetime().optional(),
  outcome: z
    .enum(['done', 'attended', 'watched', 'had_it', 'didnt_happen', 'didnt_go'])
    .optional(),
  icsSequence: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  schemaVersion: z.literal(1),
} as const;

/** The five Plan kinds. `custom` is the visible **General**. */
export const planType = z.enum(['meal', 'watch', 'event', 'outing', 'custom']);

/**
 * The stored Activity.
 *
 * **Not strict, deliberately** — unlike the inputs. A row read back from DynamoDB carries
 * `pk`, `sk` and `entity` alongside these fields, and a strict schema would reject every
 * real item the repository loads. The inputs are strict because they describe what a client
 * may send; this describes what storage holds.
 */
export const activity = z
  .discriminatedUnion('objectKind', [
    z.object({
      ...activityBaseShape,
      objectKind: z.literal('task'),
      type: z.literal('task'),
    }),
    z.object({ ...activityBaseShape, objectKind: z.literal('plan'), type: planType }),
  ])
  .superRefine((value, ctx) => {
    checkDetailsMatchType(value, ctx);
    if (value.schedule !== undefined) checkSchedule(value.schedule, ctx);
  })
  .meta({ id: 'Activity' });

/**
 * A participant supplied at creation. **Phase 6** — Phase 1's service rejects a non-empty
 * array with `Sharing is coming soon.` The field is accepted by the schema so the contract
 * is stable and the client is never rewritten.
 */
export const participantInput = z.union([
  z.strictObject({ personId: ulidId('psn') }),
  z.strictObject({
    displayName: freeText.min(1),
    email: z.email().optional(),
  }),
]);

const createFieldsShape = {
  title,
  notes: z.string().max(MAX_NOTES_LEN).optional(),
  schedule: z
    .object({
      date: isoDate,
      time: hhmm.optional(),
      endTime: hhmm.optional(),
      timezone: ianaTimezone,
    })
    .optional(),
  recurrence: recurrence.optional(),
  /**
   * Written as `REM#` rows for the **creator alone**. Never a field on the stored Activity,
   * and never a reminder for anybody else.
   */
  reminders: z.array(reminderInput).max(MAX_REMINDERS_PER_USER_PER_ACTIVITY).optional(),
  location: activityLocation.optional(),
  details: activityDetails.optional(),
  parentActivityId: ulidId('act').optional(),
  attachmentIds: z.array(ulidId('att')).max(20).optional(),
  sourceUrl: z.url().optional(),
} as const;

/**
 * `POST /v1/activities` (`api-contract.md` §2.3).
 *
 * A discriminated union on `objectKind`, so **omitting either half of the target is a
 * validation error naming it**. The Task arm accepts no participants at all; the Plan arm
 * accepts the field so Phase 6 changes no client code.
 */
export const createActivityInput = z
  .discriminatedUnion('objectKind', [
    /**
     * **Strict, and that is what enforces `participants?: never` on a Task.** A plain
     * `z.object` strips unknown keys, so a Task carrying participants would be silently
     * accepted with them dropped — the contract says reject, and "do not silently drop them"
     * is stated outright in P1-11. Strictness also turns a mistyped field (`reminder` for
     * `reminders`) into a `400` naming it rather than a save that quietly does less than the
     * user asked for.
     */
    z.strictObject({
      ...createFieldsShape,
      objectKind: z.literal('task'),
      type: z.literal('task'),
    }),
    z.strictObject({
      ...createFieldsShape,
      objectKind: z.literal('plan'),
      type: planType,
      participants: z.array(participantInput).max(MAX_PARTICIPANTS).optional(),
    }),
  ])
  .superRefine((value, ctx) => {
    checkDetailsMatchType(value, ctx);
    if (value.schedule !== undefined) checkSchedule(value.schedule, ctx);
  })
  .meta({ id: 'CreateActivityInput' });

/**
 * Inferred rather than hand-written, and inferred **from the union** rather than flattened.
 *
 * That distinction is the whole value of the type. Because it is a union, a value of this
 * type always carries a complete target pair: there is no assignable object with `objectKind`
 * and no `type`, and none with `objectKind: 'task'` and `type: 'meal'`. A draft that has not
 * been given a target cannot be widened into one, so the client cannot build a create request
 * before the user has chosen (`CLAUDE.md` rule 2, and see `client/endpoints/activities.ts`).
 *
 * Flattening it to an interface with optional fields — the shape a form store reaches for —
 * would discard exactly that guarantee.
 */
export type CreateActivityInput = z.infer<typeof createActivityInput>;

/**
 * `PATCH /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * Two things are load-bearing:
 *
 * - **`status` is accepted only as `cancelled`.** Every other value is derived server-side,
 *   so a client cannot mark something completed by patching a field.
 * - **`schedule: null` is the unschedule path**, and is meaningfully different from absent.
 *   `null` clears the schedule and returns the activity to `saved`; `undefined` means "leave
 *   it alone". `exactOptionalPropertyTypes` is on precisely so those cannot be confused.
 *
 * A cross-object change must carry a complete valid target pair — `objectKind` alone never
 * lets the server choose a type — so both are optional here but validated together.
 */
export const patchActivityInput = z
  .strictObject({
    title: title.optional(),
    notes: z.string().max(MAX_NOTES_LEN).optional(),
    schedule: z
      .object({
        date: isoDate,
        time: hhmm.nullable().optional(),
        endTime: hhmm.nullable().optional(),
        timezone: ianaTimezone,
      })
      .nullable()
      .optional(),
    recurrence: recurrence.nullable().optional(),
    location: activityLocation.nullable().optional(),
    details: activityDetails.optional(),
    sourceUrl: z.url().nullable().optional(),
    parentActivityId: ulidId('act').nullable().optional(),
    /** The only status a client may set. The rest are derived. */
    status: z.literal('cancelled').optional(),
    objectKind: z.enum(['task', 'plan']).optional(),
    type: z.enum(['task', 'meal', 'watch', 'event', 'outing', 'custom']).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.objectKind === undefined) !== (value.type === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Changing the object or Plan kind requires both objectKind and type; the server never chooses one from the other',
        path: [value.objectKind === undefined ? 'objectKind' : 'type'],
      });
    }
    if (
      value.objectKind === 'task' &&
      value.type !== undefined &&
      value.type !== 'task'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'A Task must have type "task"',
        path: ['type'],
      });
    }
    if (value.objectKind === 'plan' && value.type === 'task') {
      ctx.addIssue({
        code: 'custom',
        message: 'A Plan must have one of the five Plan kinds, not "task"',
        path: ['type'],
      });
    }
    if (value.details !== undefined && value.type !== undefined) {
      checkDetailsMatchType({ type: value.type, details: value.details }, ctx);
    }
    if (value.schedule !== undefined && value.schedule !== null) {
      checkSchedule(
        {
          date: value.schedule.date,
          time: value.schedule.time ?? undefined,
          endTime: value.schedule.endTime ?? undefined,
        },
        ctx,
      );
    }
  })
  .meta({ id: 'PatchActivityInput' });
