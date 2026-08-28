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
import { activityUpdate } from './activityUpdate.js';
import { attachment } from './attachment.js';
import { activityActionCapabilities } from './capabilities.js';
import {
  cents,
  cursor,
  hhmm,
  ianaTimezone,
  isoDate,
  ulidId,
  userId,
  watchEpisode,
  watchMediaKind,
  watchSeason,
  watchStatus,
} from './common.js';
import { occurrence } from './occurrence.js';
import { createRecurrence, recurrence } from './recurrence.js';
import { reminder, reminderInput, reminderInputsForSchedule } from './reminder.js';

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

/**
 * The schedule a **request** may carry — strict, and without the two derived UTC instants.
 *
 * Separate from the stored {@link activitySchedule} because `scheduledAtUtc` and `endAtUtc`
 * are the server's, computed from the wall-clock fields and the zone. Shared by every create
 * path — `POST /v1/activities` and P3-13's bridge — so a field one accepts is a field the
 * other accepts, and neither silently drops one the user filled in.
 */
export const activityScheduleInput = z.strictObject({
  date: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
  timezone: ianaTimezone,
});

export const activitySchedule = z.strictObject({
  date: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
  timezone: ianaTimezone,
  scheduledAtUtc: z.iso.datetime().optional(),
  endAtUtc: z.iso.datetime().optional(),
});

export const activityLocation = z.strictObject({
  label: freeText,
  address: z.string().trim().max(MAX_ADDRESS_LEN).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  mapUrl: z.url().optional(),
});

/**
 * One row of a meal's ingredient list (`data-model.md` §4.4).
 *
 * ## `ingredientId` is required, and is an embedded-row identity
 *
 * `data-model.md` §8: `ing_` is "a client-minted embedded-row identity, not an entity id".
 * It has no endpoint and no tombstone. Its whole job is to let
 * `POST /v1/activities/:id/ingredients/add-to-list` name the same row after the array has
 * moved — an offline action selected before a reorder must still add what the user picked,
 * and array position cannot say that (P3-17, `plans-and-lists.md` §7.3 step 3).
 *
 * It is **required**, not optional, because an optional one is not an identity: the server
 * would need a fallback for rows without it, and the only available fallback is the index —
 * which is precisely the thing that cannot be trusted. Removing or replacing a row makes its
 * id stale, and a stale id rejects the whole action rather than resolving to a neighbour.
 *
 * ## `addedToListId` is on the stored shape and **not** on the input one
 *
 * It records that the authorised add-to-list action ran, so a client able to set it would be
 * fabricating that for any well-formed `lst_` id — the `Added` state on a meal would stop
 * meaning anything was added. The stored shape carries it because the server writes and reads
 * it back; {@link mealIngredientInput} omits and rejects it, and that is the shape create and
 * patch validate against.
 *
 * This is exactly the split `listItemDetailsInput` has made on the list side since P3-01, for
 * the same reason and in the same words. **An earlier version of this comment claimed the
 * activity side did not need it** — that `activityDetails` was "reached only through routes
 * that never let a client author it" — which was simply false: `activityDetails` *is* the
 * create and patch body, and a `POST /v1/activities` carrying a forged `addedToListId` stored
 * it. Raised in review of P3-17.
 */
export const mealIngredient = z.strictObject({
  ingredientId: ulidId('ing'),
  name: freeText.min(1),
  quantity: freeText.optional(),
  addedToListId: ulidId('lst').optional(),
});

/** What a client may say about an ingredient. `addedToListId` is deliberately absent. */
export const mealIngredientInput = mealIngredient.omit({ addedToListId: true });

export const eventReservation = z.strictObject({
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
 *
 * **Every arm is strict, and that is what makes the sentence above true** (P3-13). A plain
 * `z.object` strips unknown keys, so `{ kind: 'meal', season: 3 }` parsed happily with
 * `season` removed and the user got a Plan quietly smaller than the one they confirmed. The
 * list schemas already took this position for the same reason — a nested object carries no
 * `pk`/`sk`, so there is nothing legitimate to strip — and the two sides now agree.
 */
function detailsUnion<T extends z.ZodTypeAny>(ingredient: T) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('task') }),
    z.strictObject({
      kind: z.literal('meal'),
      mealSlot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']).optional(),
      ingredients: z.array(ingredient).max(MAX_INGREDIENTS).optional(),
      recipeUrl: z.url().optional(),
    }),
    z.strictObject({
      kind: z.literal('watch'),
      mediaTitle: title,
      mediaKind: watchMediaKind.optional(),
      season: watchSeason.optional(),
      episode: watchEpisode.optional(),
      episodeTitle: freeText.optional(),
      service: freeText.optional(),
    }),
    z.strictObject({
      kind: z.literal('event'),
      description: z.string().trim().max(MAX_NOTES_LEN).optional(),
      priceCents: cents.nonnegative('A price cannot be negative').optional(),
      currency: z.string().length(3).optional(),
      ticketUrl: z.url().optional(),
      organiser: freeText.optional(),
      reservation: eventReservation.optional(),
    }),
    z.strictObject({ kind: z.literal('custom'), shortcutId: ulidId('sct').optional() }),
  ]);
}

/** The stored shape, including the server-owned `addedToListId`. */
export const activityDetails = detailsUnion(mealIngredient);

/**
 * The shape a **create or patch body** may carry.
 *
 * Identical to the stored union except that the meal arm's ingredients omit and reject
 * `addedToListId` (see {@link mealIngredient}). Every other arm is the same object, so this
 * is one union with one ingredient difference rather than a second copy that can drift.
 */
export const activityDetailsInput = detailsUnion(mealIngredientInput);

/**
 * `time` requires `date`; `endTime` requires `time` and must be after it
 * (`activities.md` §3 rule 4).
 *
 * Shared by the stored shape and both inputs, so the three cannot drift into disagreeing
 * about what a well-formed schedule is.
 */
export function checkSchedule(
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

/**
 * `details.kind` must equal `type`. The single most useful validation in the product.
 *
 * Exported so the list bridge (P3-13) applies the identical rule rather than restating it.
 * A second copy that drifted would let one create path accept a `meal` payload on a `watch`
 * Plan while the other refused it.
 */
export function checkDetailsMatchType(
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
  /**
   * The client's own `act_` ULID, minted before the request leaves the device
   * (Phase 2.6, ADR-055; `data-model.md` §8, `api-contract.md` §2.3).
   *
   * An offline create can then render the permanent id it will always have — no temporary
   * id, no reconciliation pipeline, no id rewriting. **Identity only.** The server still
   * derives ownership from the authenticated principal and still sets `createdAt`; an id is
   * an identifier, never a credential and never a claim, which is why the authority fields
   * remain absent from this shape rather than being accepted and ignored.
   *
   * Optional, so omitting it keeps the server-minted behaviour byte-identical — required by
   * `git-workflow.md` §6.3, which lets this land alone without breaking a branch that does
   * not know the field exists.
   */
  activityId: ulidId('act').optional(),
  title,
  notes: z.string().max(MAX_NOTES_LEN).optional(),
  schedule: activityScheduleInput.optional(),
  recurrence: createRecurrence.optional(),
  /**
   * Written as `REM#` rows for the **creator alone**. Never a field on the stored Activity,
   * and never a reminder for anybody else.
   */
  reminders: z.array(reminderInput).max(MAX_REMINDERS_PER_USER_PER_ACTIVITY).optional(),
  location: activityLocation.optional(),
  /** The input union: server-owned `addedToListId` is rejected, not dropped. */
  details: activityDetailsInput.optional(),
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
    if (value.reminders !== undefined) {
      const result = reminderInputsForSchedule(value.schedule).safeParse(value.reminders);
      if (!result.success) {
        for (const issue of result.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: ['reminders', ...issue.path],
          });
        }
      }
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
/** The server-authoritative effective state of one explicitly targeted occurrence. */
export const occurrenceDetailProjection = z.strictObject({
  nominalDate: isoDate,
  date: isoDate,
  time: hhmm.optional(),
  endTime: hhmm.optional(),
  status: z.enum([
    'saved',
    'scheduled',
    'completed',
    'skipped',
    'cancelled',
    'completed_occurrence',
    'skipped_occurrence',
  ]),
  isSnoozed: z.boolean(),
  completedAt: z.iso.datetime().optional(),
});

export const activityDetail = z
  .object({
    activity,
    /** Additive authority projection; absent only in an older cached response. */
    capabilities: activityActionCapabilities.optional(),
    /** The caller's own. Never anybody else's — see above. */
    reminders: z.array(reminder),
    /** Present exactly when the read explicitly targets one nominal occurrence. */
    occurrence: occurrenceDetailProjection.optional(),
    /** Additive Phase 2 projection; absent only in an older cached response. */
    completedOccurrenceCount: z.number().int().nonnegative().optional(),
    /**
     * The newest page of the plan's feed, embedded so opening a plan is one request
     * (§2.3, P3-19). `updatesCursor` continues it through `GET .../updates?cursor=`; its
     * absence means the feed ends here, not that paging is unavailable.
     */
    updates: z.array(activityUpdate).optional(),
    updatesCursor: z.string().min(1).optional(),
    /**
     * Every image linked to this activity (P3-22), capped at
     * `MAX_ATTACHMENTS_PER_ACTIVITY`. Bounded by the model, so there is no cursor beside it.
     */
    attachments: z.array(attachment).optional(),
  })
  .meta({ id: 'ActivityDetail' });

/** Optional wire query converted immediately into an `ActivityDetailTarget`. */
export const activityDetailQuery = z.strictObject({ occurrenceDate: isoDate.optional() });
export type ActivityDetailQuery = z.infer<typeof activityDetailQuery>;

/** Atomic existing-series conversion; a series-only detail may never guess this date. */
export const convertRecurrenceInput = z
  .strictObject({ occurrenceDate: isoDate })
  .meta({ id: 'ConvertRecurrenceInput' });
export type ConvertRecurrenceInput = z.infer<typeof convertRecurrenceInput>;

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
    /** The input union: server-owned `addedToListId` is rejected, not dropped. */
    details: activityDetailsInput.optional(),
    sourceUrl: z.url().nullable().optional(),
    parentActivityId: ulidId('act').nullable().optional(),
    /** The only status a client may set. The rest are derived. */
    status: z.literal('cancelled').optional(),
    objectKind: z.enum(['task', 'plan']).optional(),
    type: activityType.optional(),
    /**
     * `Set as cover` (P3-22). Nullable: `null` clears the hero, absent leaves it alone.
     *
     * The shape is all this schema can check. **Whether the id names an attachment on
     * *this* activity is the server's**, validated against the activity's own rows before
     * the write — a client could otherwise point the hero at an id it invented, or at a real
     * attachment belonging to somebody else's plan, and the field would render as an image
     * request for a key the caller was never allowed to see.
     */
    primaryAttachmentId: ulidId('att').nullable().optional(),
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

/** Skip either the activity itself or one nominal recurring occurrence. */
export const skipActivityInput = z
  .strictObject({ occurrenceDate: isoDate.optional() })
  .meta({ id: 'SkipActivityInput' });

/**
 * What both watch follow-ups say about the item they would update.
 *
 * Everything here is read from the ListItem, so the client renders
 * `Movies and shows · currently S2 E4` without a second request
 * (`plans-and-lists.md` §8.4 step 2), and builds the confirming `PATCH` from the same
 * payload: an item `details` body is a whole replacement, so `mediaKind` and
 * `current.watchStatus` are needed to preserve one and to apply `want → watching` to the
 * other.
 *
 * **`mediaKind` is deliberately not here.** It is the field that *chooses* the arm, so
 * sharing it would let the two disagree: a `watch_progress` claiming `movie`, or a
 * `watch_watched` claiming `show` — the manual-only transition offered on something whose
 * ending the app cannot know (`plans-and-lists.md` §8.1). Each arm states its own, which is
 * the whole reason there are two.
 */
const watchFollowUpItem = {
  listId: ulidId('lst'),
  /** The list's current title, because the copy names it: `Update {list name} item to…`. */
  listTitle: title,
  itemId: ulidId('itm'),
  /** Where the item is now — the `currently S2 E4` half of the question. */
  current: z.strictObject({
    watchStatus,
    season: watchSeason.optional(),
    episode: watchEpisode.optional(),
  }),
} as const;

/**
 * The session's own progress, and **at least one of the two**.
 *
 * A union of the two shapes rather than a pair of optionals with a refinement, because an
 * empty target is not a weaker version of this question — it is not a question at all.
 * `Update to ?` renders nothing a user can answer, and a client building the confirming
 * `PATCH` from `{}` sends a `details` body that changes only `watchStatus`, quietly turning
 * the progress row into a status write nobody asked for. The service already declines to
 * emit one; this is what stops the contract from describing it as legal (P3-44).
 *
 * Read as: season with an optional episode, or an episode on its own. `{ season, episode }`,
 * `{ season }` and `{ episode }` all pass; `{}` matches neither arm.
 */
const watchProgressTarget = z.union([
  z.strictObject({ season: watchSeason, episode: watchEpisode.optional() }),
  z.strictObject({ season: watchSeason.optional(), episode: watchEpisode }),
]);

/**
 * The **one** contextual follow-up a completion may offer (P3-16, for P3-24 and P3-44).
 *
 * ## It is data, and only data
 *
 * Nothing here has been written. The completion wrote the Activity and nothing else; this
 * describes an update the user may confirm, and confirming it is an ordinary
 * `PATCH /v1/lists/:id/items/:itemId` the client issues, through the route that already
 * enforces every behaviour and field gate. There is no confirm endpoint and there is no
 * server-side accept: `interaction-contract.md` §1a.2 makes an accepted follow-up its own
 * user action with its own undo, and a second write hanging off the completion would be
 * exactly the auto-create `CLAUDE.md` rule 5 and `agent-playbook.md` §6.9 exist to prevent.
 * Dismissal is therefore not a request at all — it is the absence of one.
 *
 * ## One field, not one per catalogue row
 *
 * `interaction-contract.md` §1a.2 allows **exactly one** follow-up, and a union in one
 * optional field is what makes a second one unrepresentable. Sibling optional fields —
 * `watchFollowUp`, `mealFollowUp`, `prepTaskFollowUp` — would let a response carry three at
 * once and leave "one at a time" as a rule some future handler has to remember. The
 * remaining rows of `activities.md` §5.3 arrive as further arms, and the priority between
 * them is decided here, once, where the response is built.
 *
 * ## Why two arms rather than one with a variable target
 *
 * §5.3 has two watch rows with two different questions and two different writes:
 * `… currently S2 E4 — Update to S2 E5?` advances progress, and
 * `Update {list name} item to Watched?` moves a movie's status. A show has no `watched`
 * target — the app does not know how many episodes there are, so that transition is manual
 * only (`plans-and-lists.md` §8.1) — and a movie has no episode to advance to.
 *
 * So each arm pins **both halves of its own row**: its `mediaKind` and its `target`. Pinning
 * only the target would leave `kind` and `mediaKind` free to contradict each other, and the
 * contradiction is the exact mistake the two arms exist to prevent — a `show` offered the
 * manual-only watched transition, or a `movie` handed an episode to advance to.
 *
 * A `watch_progress` target may repeat the item's current values: that is a **rewatch**, and
 * §8.4 names it as a case the user answers by dismissing. The server does not decide the
 * question is not worth asking.
 */
export const completionFollowUp = z
  .discriminatedUnion('kind', [
    /** The show row: offer this session's season and episode. */
    z.strictObject({
      kind: z.literal('watch_progress'),
      ...watchFollowUpItem,
      /**
       * `show`, or absent — never `movie`, which takes the other arm by construction.
       *
       * Optional because the item's own field is, and P3-09's back-fill leaves a whole
       * upgraded `collection` without one (§8.4's decision). What the arm offers is the
       * season and episode the user typed on this session, which is not an opinion about
       * what kind of thing the item is (`CLAUDE.md` rule 2).
       */
      mediaKind: z.literal('show').optional(),
      /** Where §8.4's `Update to S2 E5?` comes from. Never empty — see the union above. */
      target: watchProgressTarget,
    }),
    /** The movie row: offer the one transition a completed movie session evidences. */
    z.strictObject({
      kind: z.literal('watch_watched'),
      ...watchFollowUpItem,
      /** Required, and only this: the row exists *because* the item says it is a movie. */
      mediaKind: z.literal('movie'),
      target: z.strictObject({ watchStatus: z.literal('watched') }),
    }),
  ])
  .meta({ id: 'CompletionFollowUp' });

export type CompletionFollowUp = z.infer<typeof completionFollowUp>;

/**
 * Canonical mutation result for complete and uncomplete.
 *
 * `followUp` is additive and optional in both directions: a client that does not know the
 * field ignores it, and a completion that has nothing to suggest omits it rather than
 * sending an empty one. Its absence is the normal case and carries no information — a
 * recurring occurrence, a negative outcome, an unlinked Plan and a list changed away from
 * `watch` all produce the same silence, deliberately (P3-16).
 */
export const activityCompletionResult = z
  .object({
    activity,
    occurrenceDate: isoDate.optional(),
    occurrence: occurrence.optional(),
    outcome: activityOutcome.optional(),
    followUp: completionFollowUp.optional(),
  })
  .meta({ id: 'ActivityCompletionResult' });

export type CompleteActivityInput = z.infer<typeof completeActivityInput>;
export type UncompleteActivityInput = z.infer<typeof uncompleteActivityInput>;
export type SkipActivityInput = z.infer<typeof skipActivityInput>;
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
