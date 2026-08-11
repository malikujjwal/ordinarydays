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
import { cents, cursor, hhmm, ianaTimezone, isoDate, ulidId, userId } from './common.js';
import { occurrence } from './occurrence.js';
import { createRecurrence, recurrence } from './recurrence.js';
import { reminder, reminderInput } from './reminder.js';

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

export const eventReservation = z.object({
  name: freeText.optional(),
  time: hhmm.optional(),
  partySize: z.number().int().positive().max(99).optional(),
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
    reservation: eventReservation.optional(),
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

export const activityOutcome = z.enum([
  'done',
  'attended',
  'watched',
  'had_it',
  'didnt_happen',
  'didnt_go',
]);

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
  snoozedUntil: z.union([hhmm, z.iso.datetime()]).optional(),
  outcome: activityOutcome.optional(),
  icsSequence: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  lastActivityAt: z.string().min(1),
  updatedAt: z.string().min(1),
  schemaVersion: z.literal(1),
} as const;

/** The four Plan kinds. `custom` is the visible **General**. */
export const planType = z.enum(['meal', 'watch', 'event', 'custom']);

/**
 * Every activity type, Task included. Named once here rather than spelled out at each use —
 * `patchActivityInput` and `activityListQuery` both need the full five.
 */
export const activityType = z.enum(['task', 'meal', 'watch', 'event', 'custom']);

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
    if (value.recurrence !== undefined && value.schedule === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Repeat needs a scheduled date.',
        path: ['recurrence'],
      });
    }
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
  recurrence: createRecurrence.optional(),
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
    if (value.recurrence !== undefined && value.schedule === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Repeat needs a scheduled date.',
        path: ['recurrence'],
      });
    }
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
 * `GET /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * ## This is Phase 1's subset, and it is additive by construction
 *
 * The contract describes the full response as "activity + participants + expenses + updates
 * + attachments + children + **the caller's own reminders** + date suggestions". Six of those
 * eight have no schema, no key builder and no row anywhere in the repository yet — they are
 * Phase 3, 6 and 7. Defining them now would be inventing six shapes against no
 * implementation, and the first task that wrote one would change them.
 *
 * So this names the two that exist, and every absent collection arrives as an **optional
 * array added to this object** rather than as a redefinition. A client written against this
 * keeps working when P6-xx adds `participants`; that is the whole reason the envelope is an
 * object with named collections rather than a bare `Activity`.
 *
 * > **Owned by P1-12, defined here by P1-26.** P1-12 is the task that builds the endpoint and
 * > it had not landed when the detail screen was written. Extending this is expected; changing
 * > the two fields below is a contract break and needs the client changed with it.
 *
 * ## `reminders` is the caller's own, always
 *
 * The `REM#` rows for **every** participant live in the `ACT#<id>` partition that the single
 * Query reads, so the handler must filter to `c.get('userId')` in the projection before
 * serialising (`security-privacy.md` §1 row 15, ADR-047). That filter is a server obligation
 * this schema cannot enforce — but naming the field `reminders` rather than something that
 * sounds collective is the smallest thing that keeps a reader from assuming otherwise. A
 * shared plan has one schedule and many reminder sets; nobody sees anybody else's, not even
 * that they have any.
 */
export const activityDetail = z
  .object({
    activity,
    /** The caller's own. Never anybody else's — see above. */
    reminders: z.array(reminder),
  })
  .meta({ id: 'ActivityDetail' });

/**
 * `PATCH /v1/activities/:id` (`api-contract.md` §2.3).
 *
 * Two things are load-bearing:
 *
 * - **`status` is accepted only as `cancelled`.** Every other value is derived server-side,
 *   so a client cannot mark something completed by patching a field.
 * Schedule is deliberately absent. `POST /v1/activities/:id/schedule` is the only write path
 * for schedule fields and unscheduling, so a PATCH carrying `schedule` is rejected by this
 * strict schema rather than temporarily supporting two paths.
 *
 * A cross-object change must carry a complete valid target pair — `objectKind` alone never
 * lets the server choose a type — so both are optional here but validated together.
 */
export const patchActivityInput = z
  .strictObject({
    title: title.optional(),
    notes: z.string().max(MAX_NOTES_LEN).optional(),
    recurrence: recurrence.nullable().optional(),
    editedFromDate: isoDate.optional(),
    location: activityLocation.nullable().optional(),
    details: activityDetails.optional(),
    sourceUrl: z.url().nullable().optional(),
    parentActivityId: ulidId('act').nullable().optional(),
    /** The only status a client may set. The rest are derived. */
    status: z.literal('cancelled').optional(),
    objectKind: z.enum(['task', 'plan']).optional(),
    type: activityType.optional(),
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
        message: 'A Plan must have one of the four Plan kinds, not "task"',
        path: ['type'],
      });
    }
    if (value.details !== undefined && value.type !== undefined) {
      checkDetailsMatchType({ type: value.type, details: value.details }, ctx);
    }
    if (value.editedFromDate !== undefined && value.recurrence == null) {
      ctx.addIssue({
        code: 'custom',
        message: 'editedFromDate requires a recurrence segment append.',
        path: ['editedFromDate'],
      });
    }
  })
  .meta({ id: 'PatchActivityInput' });

/**
 * Inferred, like `CreateActivityInput`, and for a related reason: every field is optional
 * here, but `objectKind` and `type` are optional **together** — the `superRefine` above
 * rejects one without the other. A hand-written interface would express "both optional" and
 * lose the pairing, which is the one thing this input exists to guarantee.
 */
export type PatchActivityInput = z.infer<typeof patchActivityInput>;

/** Complete either the activity itself or one nominal recurring occurrence. */
export const completeActivityInput = z
  .strictObject({
    occurrenceDate: isoDate.optional(),
    outcome: activityOutcome.optional(),
  })
  .meta({ id: 'CompleteActivityInput' });

/** Reverse completion/skipping for the activity or one nominal recurring occurrence. */
export const uncompleteActivityInput = z
  .strictObject({ occurrenceDate: isoDate.optional() })
  .meta({ id: 'UncompleteActivityInput' });

/** Canonical mutation result for complete and uncomplete. */
export const activityCompletionResult = z
  .object({
    activity,
    occurrenceDate: isoDate.optional(),
    occurrence: occurrence.optional(),
    outcome: activityOutcome.optional(),
  })
  .meta({ id: 'ActivityCompletionResult' });

export type CompleteActivityInput = z.infer<typeof completeActivityInput>;
export type UncompleteActivityInput = z.infer<typeof uncompleteActivityInput>;
export type ActivityCompletionResult = z.infer<typeof activityCompletionResult>;

/**
 * What a `DELETE` acknowledges: the id that is now gone.
 *
 * A body rather than a `204`, per the convention `api-contract.md` §1 records — every
 * endpoint returns the envelope, and a `204` has no body to carry one in. Named `data` rather
 * than left empty so the response is self-describing in a log or a replayed request. The same
 * shape `DeletedDevice` uses, deliberately: two delete endpoints should not answer in two
 * different ways.
 */
export const deletedActivity = z
  .object({ activityId: ulidId('act') })
  .meta({ id: 'DeletedActivity' });

/**
 * The stages `GET /v1/activities?filter=` serves (`api-contract.md` §2.2).
 *
 * Each maps to exactly **one** GSI1 bucket, which is what lets one Query and one cursor
 * answer a page — the orders come from §2.2a's stage table:
 *
 * | Filter | Bucket | Order |
 * | --- | --- | --- |
 * | `upcoming` | `#S`, from today forward | date ascending |
 * | `past` | `#S`, before today | date descending |
 * | `needs_date` | `#P` | `lastActivityAt` descending |
 * | `saved` | `#N` | newest first |
 *
 * > **Amended in P1-16.** The contract's enum read `inbox|upcoming|past|saved`, and two of
 * > those could not be built as written.
 * >
 * > **`inbox` is gone.** Nothing defined it: no product surface, no GSI1 bucket, no access
 * > pattern — and `overview.md` §"Why it must stay three" names Inbox among the fourth nouns
 * > the product deliberately does not have. A member of a closed enum that no handler can
 * > implement is a value every client must handle and will never see.
 * >
 * > **`saved` was aimed at two buckets by two product docs** — `today-and-tasks.md` §2.3 at
 * > `#N` (the ANYTIME See-all) and `plans-and-lists.md` §5 at `#P` (Needs a date). They are
 * > separate partitions, so one filter cannot page across both without a composite cursor no
 * > document defines; and merging them would put undecided plans on the ANYTIME screen, which
 * > `today-and-tasks.md` calls "the model's largest product error" two paragraphs above the
 * > line that cites the filter. `saved` keeps the `#N` meaning and `needs_date` names the
 * > stage that already had its own name, access pattern (2b) and empty-state copy.
 */
export const activityFilter = z.enum(['upcoming', 'past', 'saved', 'needs_date']);

/**
 * `GET /v1/activities` query parameters.
 *
 * **Strict**, so a misspelled filter is a `400` naming it rather than a silent fallback to
 * whichever stage the server would have picked — there is no default: `filter` is required,
 * because a flat list of everything is not one of the stages the product has.
 */
export const activityListQuery = z
  .strictObject({
    filter: activityFilter,
    /** Narrows to one activity type. Applied after the Query — see the endpoint's note. */
    type: activityType.optional(),
    cursor: cursor.optional(),
    /** `api-contract.md` §1: default 50, max 200. */
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .meta({ id: 'ActivityListQuery' });

export type ActivityListQuery = z.infer<typeof activityListQuery>;

/**
 * One row of a flat list — the **index entry's** projection, not the full Activity.
 *
 * ## Deliberately not `AgendaItem`
 *
 * `api-contract.md` §2.2 defines `AgendaItem` with `occurrenceDate`, `isSnoozed`, `isPast`
 * and `overdueFromDate`, every one of which only exists after recurrence expansion and
 * occurrence merging. That is the agenda endpoint's work and Phase 2 owns both it and
 * `types/agenda.ts`. This endpoint is "**Not for Today**" in the contract's own words and
 * expands nothing, so it answers with what the index row actually holds rather than with a
 * richer shape whose extra fields it would have to invent.
 *
 * The two shapes overlap because they are projections of the same row. When Phase 2 defines
 * `AgendaItem`, this stays as it is: a list stage and a day view are different reads.
 */
export const activityListItem = z
  .object({
    activityId: ulidId('act'),
    type: activityType,
    title,
    status: z.enum(['saved', 'scheduled', 'completed', 'skipped', 'cancelled']),
    time: hhmm.optional(),
    endTime: hhmm.optional(),
    isRecurring: z.boolean(),
    participantCount: z.number().int().nonnegative(),
    locationLabel: freeText.optional(),
    subtitle: freeText.optional(),
  })
  .meta({ id: 'ActivityListItem' });
