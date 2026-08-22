import { assertNever, MAX_AUTOMATIC_INTENT_AGE_DAYS } from '@od/shared';
import { deriveGsi1Bucket } from '@od/shared/activity';
import { activity as activitySchema } from '@od/shared/schemas';
import { TABLE } from '@od/shared/table';
import type { Activity, ActivitySchedule, Gsi1Bucket, Reminder } from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import {
  type CleanupWork,
  IdempotencyRaceError,
  type IdempotencyReceipt,
} from '../lib/idempotency.js';
import { batchGetItems, deleteAll, getItem, type Page, query, queryAll } from './base.js';
import { cleanupItem, receiptItem } from './idempotencyRepository.js';
import {
  activityIndex,
  activityMeta,
  activityPartition,
  activityTombstone,
  childPointer,
  childPointerPrefix,
  gsi1Anytime,
  gsi1Bucket as gsi1BucketKey,
  gsi1NeedsDate,
  gsi1Recurring,
  gsi1Scheduled,
  occurrence,
  participantPrefix,
  reminder as reminderKey,
} from './keys.js';
import type { StoredItem } from './migrate.js';
import { type TransactItem, TransactionBuilder, transactWrite } from './tx.js';

/**
 * The only place an Activity is read from or written to DynamoDB.
 *
 * Implements access patterns 1, 2, 3, 4, 4b, 5 and 16 (`data-model.md` §5) and the *Create
 * activity* write path (§7).
 *
 * ## What this layer is not
 *
 * It **stores** rather than decides. Status derivation, `scheduledAtUtc`, the nesting cap and
 * every authorisation rule are P1-10's, one layer up; this file would be the wrong place for
 * them because a rule enforced here is a rule the service cannot test without a database.
 *
 * Its write functions are **deterministic**: no clock, no id generation. They receive a
 * fully-formed `Activity` whose `activityId`, `createdAt` and `updatedAt` are already set,
 * which is what makes the conditional-update-on-`updatedAt` path testable without freezing
 * time. The two id **generators** below are exports beside them, not calls inside them, so
 * that property is unchanged — the same arrangement `newUserId` has in `userRepository.ts`
 * and `newDeviceId` in `deviceRepository.ts`, and the reason a service can mint an id and
 * still hand this layer a value it did not invent.
 *
 * ## The rule that runs through all of it
 *
 * **Every method takes `userId` first and every query is scoped by it.** There is no concept
 * of a current user here and no access to the Hono context — the tenancy is in the key, and
 * `keys.ts` is where it is built.
 */

/**
 * The `act_` and `rem_` id generators (`data-model.md` §8), added in P1-10.
 *
 * `monotonicFactory`, not the bare `ulid()`, for the reason `newUserId` records: plain ULIDs
 * minted inside one millisecond break the tie with random bits and sort arbitrarily, which is
 * exactly the time-ordering guarantee §8 says the choice was made for. One factory per
 * sequence, so an activity id and a reminder id minted in the same request do not have to
 * share a counter to be individually ordered.
 */
const nextActivityUlid = monotonicFactory();
const nextReminderUlid = monotonicFactory();

export function newActivityId(): string {
  return `act_${nextActivityUlid()}`;
}

export function newReminderId(): string {
  return `rem_${nextReminderUlid()}`;
}

/** The `entity` discriminator every item carries (`data-model.md` §3). */
const ENTITY = {
  activity: 'Activity',
  index: 'ActivityIndex',
  reminder: 'Reminder',
  childPointer: 'ChildPointer',
  /** The deletion marker a client-minted create is condition-checked against (Phase 2.6). */
  tombstone: 'ActivityTombstone',
} as const;

/**
 * The id a create asked for is not available — taken, or tombstoned.
 *
 * **One error for both**, deliberately. Telling the two apart would report the fate of an id
 * the caller may not own, and the client's recovery does not branch on it: it reads its own
 * id and the answer decides (`data-model.md` §8). The residual existence signal in
 * success-versus-failure is accepted and bounded there rather than papered over here.
 */
export class ActivityIdUnavailableError extends Error {
  constructor() {
    super('That id is not available.');
    this.name = 'ActivityIdUnavailableError';
  }
}

const SCHEMA_VERSION = 1;
const storedItemKey = z.object({ pk: z.string(), sk: z.string() });

/**
 * The `#S` sort key's date-time, as the user's local wall clock: `YYYY-MM-DDTHH:mm`.
 *
 * **No timezone arithmetic happens here, and none is needed.** `schedule.date` and
 * `schedule.time` are already stored as user-local wall clock (`data-model.md` §4.1), so this
 * is string composition. The absolute instant lives separately on `META` as `scheduledAtUtc`,
 * derived by the service with `date-fns-tz` for reminders and `.ics`.
 *
 * An untimed item gets `00:00`, so it **sorts before** every timed item on the same date.
 * That is the intended order and Phase 2's agenda partitioning depends on it.
 */
export function localDateTime(schedule: Pick<ActivitySchedule, 'date' | 'time'>): string {
  return `${schedule.date}T${schedule.time ?? '00:00'}`;
}

/** The GSI1 key pair for an activity, given the bucket it belongs in. */
function gsi1KeysFor(
  userId: string,
  activity: Activity,
): { gsi1pk: string; gsi1sk: string } {
  const bucket = deriveGsi1Bucket(activity);
  const id = activity.activityId;

  switch (bucket) {
    case 'R': {
      /**
       * The **first** segment's `effectiveFrom`, not the active one. It is immutable, so
       * appending a segment — which is what every "all future occurrences" edit does — never
       * rewrites this index key.
       */
      const seriesStart =
        activity.recurrence?.segments[0]?.effectiveFrom ?? activity.createdAt;
      return gsi1Recurring(userId, seriesStart, id);
    }
    case 'S':
      /**
       * `schedule` is defined whenever the bucket is `S` — its `date` is what put it there —
       * but the compiler cannot see that through {@link deriveGsi1Bucket}, so the fallback is a
       * narrowing rather than an assertion. It is unreachable, and being unreachable is
       * cheaper to read than a non-null assertion that claims something the reader has to
       * verify for themselves.
       */
      return activity.schedule === undefined
        ? gsi1Anytime(userId, activity.createdAt, id)
        : gsi1Scheduled(userId, localDateTime(activity.schedule), id);
    case 'P':
      /**
       * Sorted by `lastActivityAt` descending, so the plan people are actually discussing
       * floats up rather than the oldest one. Creation initialises it to `createdAt`, and
       * discussion writers move it without touching edit-concurrency state.
       */
      return gsi1NeedsDate(userId, activity.lastActivityAt, id);
    case 'N':
      return gsi1Anytime(userId, activity.createdAt, id);
    default:
      return assertNever(bucket, 'Gsi1Bucket');
  }
}

/**
 * The `AgendaItem` fields projected onto the index entry
 * (`GSI1_PROJECTED_ATTRIBUTES`, `api-contract.md` §2.2).
 *
 * `INCLUDE`, never `ALL`: the agenda query is the hottest read in the product, so the
 * projection is only what a row renders. The fields deliberately absent are the ones computed
 * at read time — `hasCheckbox` is `type === 'task'`, `isPast` and `overdueFromDate` depend on
 * the caller's today, and `occurrenceDate`/`isSnoozed` come from expanding a series.
 */
export interface IndexProjection {
  type: Activity['type'];
  title: string;
  status: Activity['status'];
  lastActivityAt: string;
  timezone?: string;
  time?: string;
  endTime?: string;
  isRecurring: boolean;
  participantAvatars: { personId: string; displayName: string; avatarUrl?: string }[];
  participantCount: number;
  locationLabel?: string;
  subtitle?: string;
}

/**
 * A type-derived subtitle, per `today-and-tasks.md` §4.
 *
 * **A `task`'s subtitle is its parent plan's title**, which this layer does not have — so the
 * caller supplies it. P1-10 already loads the parent to enforce the nesting cap, so the title
 * is in hand there and no extra read enters the write path.
 */
function deriveSubtitle(activity: Activity, taskSubtitle?: string): string | undefined {
  switch (activity.details.kind) {
    case 'task':
      return taskSubtitle;
    case 'meal':
      return activity.details.mealSlot === undefined
        ? 'Meal'
        : `Meal · ${capitalise(activity.details.mealSlot)}`;
    case 'watch': {
      const { season, episode, mediaKind } = activity.details;
      if (season !== undefined && episode !== undefined) {
        return `Watch · S${season} E${episode}`;
      }
      return mediaKind === undefined ? 'Watch' : `Watch · ${capitalise(mediaKind)}`;
    }
    case 'event':
      return activity.details.organiser ?? activity.location?.label;
    case 'custom':
      return undefined;
    default:
      return assertNever(activity.details, 'ActivityDetails');
  }
}

const capitalise = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Builds the full `ActivityIndex` item for one user. */
function indexItem(
  userId: string,
  activity: Activity,
  taskSubtitle?: string,
): StoredItem {
  const subtitle = deriveSubtitle(activity, taskSubtitle);

  return stamp(ENTITY.index, activity, {
    ...activityIndex(userId, activity.activityId),
    ...gsi1KeysFor(userId, activity),
    activityId: activity.activityId,
    type: activity.type,
    title: activity.title,
    status: activity.status,
    lastActivityAt: activity.lastActivityAt,
    ...(activity.schedule?.timezone === undefined
      ? {}
      : { timezone: activity.schedule.timezone }),
    ...(activity.schedule?.time === undefined ? {} : { time: activity.schedule.time }),
    ...(activity.schedule?.endTime === undefined
      ? {}
      : { endTime: activity.schedule.endTime }),
    isRecurring: activity.recurrence !== undefined,
    // Phase 6 fills these; the shape is here so the projection is complete from the first
    // write and no row needs backfilling when sharing arrives.
    participantAvatars: [],
    participantCount: activity.participantCount,
    ...(activity.location?.label === undefined
      ? {}
      : { locationLabel: activity.location.label }),
    ...(subtitle === undefined ? {} : { subtitle }),
  });
}

/**
 * Stamps the four attributes every item carries (`data-model.md` §3).
 *
 * Centralised so no write path can forget one — a row without `schemaVersion` is a row
 * `migrate.ts` has to guess about, and a row without `entity` is one nothing can identify
 * from a table scan of the partition it lives in.
 */
function stamp(
  entity: string,
  from: Pick<Activity, 'createdAt' | 'updatedAt'>,
  item: Record<string, unknown>,
): StoredItem {
  return {
    ...item,
    entity,
    createdAt: from.createdAt,
    updatedAt: from.updatedAt,
    schemaVersion: SCHEMA_VERSION,
  };
}

export interface CreateOptions {
  /**
   * Reminders to write for the **creator alone**. There is no path by which one user's
   * create writes a reminder for another, in this phase or any later one — a joiner's
   * reminder comes from their own saved default at join time (P6-13). ADR-047.
   */
  readonly reminders?: readonly { reminderId: string; offsetMinutes: number }[];
  /** A task's subtitle: its parent plan's title. See {@link deriveSubtitle}. */
  readonly taskSubtitle?: string;
  /** Title and status for the `SUB#` pointer, when this activity has a parent. */
  readonly childPointerRank?: string;
  /** Successful HTTP receipt attached to this domain transaction (P2-38). */
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/**
 * Creates an activity and everything that must exist with it, in **one transaction**
 * (`data-model.md` §7).
 *
 * Items written: `ACT#/META`, the owner's `USER#/IDX#`, one `ACT#/REM#<userId>#<id>` per
 * supplied reminder, and — when `parentActivityId` is set — the parent's `ACT#/SUB#<child>`
 * pointer, so plan detail renders its prep tasks from the same single `Query` as everything
 * else (§3.1).
 */
export async function createActivity(
  userId: string,
  activity: Activity,
  options: CreateOptions = {},
): Promise<void> {
  const items: TransactItem[] = [
    {
      Put: {
        Item: stamp(ENTITY.activity, activity, {
          ...activityMeta(activity.activityId),
          ...activity,
        }),
        /**
         * **Conditional, always** (Phase 2.6, ADR-055).
         *
         * A server-minted ULID never collides, so this costs a server-minted create nothing.
         * A **client-minted** one can arrive twice — a replay whose first response was lost —
         * or name an id that already exists, and an unconditional `Put` would silently
         * overwrite somebody's activity with the replayer's body. The condition turns both
         * into a failure the client recovers from by reading its own id.
         */
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    /**
     * The tombstone check, in the same transaction as the write it guards.
     *
     * A create replayed after the entity was deleted on another device must not resurrect
     * it. Checking separately before the put would leave a window where the delete lands in
     * between; a `ConditionCheck` makes "the id was never deleted" part of the same atomic
     * unit as "the id is free".
     */
    {
      ConditionCheck: {
        Key: activityTombstone(activity.activityId),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    { Put: { Item: indexItem(userId, activity, options.taskSubtitle) } },
  ];

  for (const entry of options.reminders ?? []) {
    const row: Reminder = {
      reminderId: entry.reminderId,
      activityId: activity.activityId,
      userId,
      offsetMinutes: entry.offsetMinutes,
      channel: 'push',
    };
    items.push({
      Put: {
        Item: stamp(ENTITY.reminder, activity, {
          ...reminderKey(activity.activityId, userId, entry.reminderId),
          ...row,
        }),
      },
    });
  }

  if (activity.parentActivityId !== undefined) {
    items.push({
      Put: {
        Item: stamp(ENTITY.childPointer, activity, {
          ...childPointer(activity.parentActivityId, activity.activityId),
          childActivityId: activity.activityId,
          title: activity.title,
          status: activity.status,
          rank: options.childPointerRank ?? activity.createdAt,
        }),
      },
    });
  }

  const builder = new TransactionBuilder(
    'createActivity',
    options.idempotencyReceipt === undefined ? 0 : 1,
  ).add(...items);
  const receiptIndex = builder.length;
  if (options.idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(options.idempotencyReceipt));
  }
  await transactWrite(builder.build(), {
    operation: 'createActivity',
    /**
     * Items 0 and 1 are the `META` put and the tombstone check, so either failing means the
     * id is unavailable. **Both map to the same generic error**: distinguishing "taken" from
     * "deleted" would tell a caller which of the two happened to an id it may not own, and
     * the client's recovery is identical either way — read its own id and let the answer
     * decide (`data-model.md` §8).
     */
    onConditionFailed: (index) => {
      if (index === 0 || index === 1) return new ActivityIdUnavailableError();
      return options.idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined;
    },
  });
}

/**
 * Every item under `ACT#<id>` — `REM#` rows included, **unfiltered** (patterns 4 and 4b).
 *
 * The two consumers want different subsets and this serves both by serving neither specially:
 * the plan-detail projection drops every `REM#` row that is not the caller's (P1-10 rule 6),
 * and the Phase 5 reminder scheduler keeps all of them and fans out per user. A repository
 * that filtered here would make the scheduler impossible to express without a second read of
 * a partition it had just loaded.
 */
export async function getActivityPartition(activityId: string): Promise<StoredItem[]> {
  return queryAll<StoredItem>(activityPartition(activityId));
}

/** Strong canonical partition read used by authoritative detail and Agenda reconciliation. */
export async function getActivityPartitionStrong(
  activityId: string,
): Promise<StoredItem[]> {
  return queryAll<StoredItem>(activityPartition(activityId), { consistentRead: true });
}

/** Parses the canonical META row already obtained as part of a partition read. */
export function activityFromPartition(
  partition: readonly StoredItem[],
): Activity | undefined {
  const meta = partition.find((row) => row.sk === 'META');
  return meta === undefined ? undefined : parseActivity(meta);
}

/** The `META` row alone, for the paths that do not need the whole partition. */
export async function getActivityMeta(activityId: string): Promise<Activity | undefined> {
  return getItem<Activity & StoredItem>(activityMeta(activityId));
}

/** Adds a META-only Activity replacement to an action transaction. */
export function putActivityMeta(
  next: Activity,
  expectedUpdatedAt: string,
  transaction: TransactionBuilder,
): void {
  transaction.add({
    Put: {
      Item: stamp(ENTITY.activity, next, { ...activityMeta(next.activityId), ...next }),
      ConditionExpression: '#updatedAt = :expected',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':expected': expectedUpdatedAt },
    },
  });
}

/** Batch-hydrates canonical META rows; missing rows are omitted. */
export async function batchGetActivityMeta(
  activityIds: readonly string[],
): Promise<Activity[]> {
  const uniqueIds = [...new Set(activityIds)];
  const rows = await batchGetItems<StoredItem>(uniqueIds.map(activityMeta));
  return rows.map(parseActivity);
}

function parseActivity(value: unknown): Activity {
  const parsed = activitySchema.parse(value);
  // Zod models optional keys as value | undefined; exactOptionalPropertyTypes models absence.
  return parsed as Activity;
}

/**
 * The `PART#` rows alone — the participant half of `assertActivityAccess` (P1-10).
 *
 * Added in P1-10 rather than Phase 6, because the authorisation rule needs it before the
 * first participant exists: `authz.ts` reads it only when the caller is **not** the owner, so
 * the Phase 1 path — every activity belongs to the one user there is — never issues this
 * query at all. Bounded by `MAX_PARTICIPANTS`, which is why `queryAll` is safe here and is
 * not safe for anything a user can grow without limit.
 *
 * Returns rows rather than a `Participant[]`: there is no `Participant` type in
 * `packages/shared` until Phase 6 defines it, and inventing one here to satisfy a read would
 * be inventing a shape against no implementation.
 */
export async function listParticipants(activityId: string): Promise<StoredItem[]> {
  const prefix = participantPrefix(activityId);
  return queryAll<StoredItem>({ pk: prefix.pk }, { skPrefix: prefix.skPrefix });
}

export interface PatchOptions extends CreateOptions {
  /**
   * The index entry as it is **now**, so a bucket change can delete the old row in the same
   * transaction that writes the new one. Supply the activity as it was read.
   */
  readonly previous: Activity;
  /** Owner plus every participating app user. Phase 6 supplies more than one. */
  readonly indexedUserIds?: readonly string[];
  /** Keep the parent's denormalised `SUB#` title/status in the same transaction. */
  readonly updateChildPointer?: boolean;
  /** A same-day recurrence correction is valid only while that date has no stored history. */
  readonly requireMissingOccurrenceDate?: string;
  /** Pins the selected occurrence read by an atomic series-to-one-off conversion. */
  readonly occurrenceGuard?:
    | { readonly date: string; readonly kind: 'missing' }
    | { readonly date: string; readonly kind: 'version'; readonly updatedAt: string };
}

/**
 * Updates `ACT#/META` conditionally on `updatedAt`, and rewrites the index entries.
 *
 * **Optimistic concurrency**: the write is conditional on the `updatedAt` the caller read, so
 * two overlapping edits cannot silently overwrite each other. A mismatch cancels the
 * transaction and surfaces as `409 conflict` (P1-13).
 *
 * **The index entry is written as a whole item, never patched.** This is the corrected form
 * of P1-09's "delete and re-put" instruction, which cannot be implemented literally — see
 * below.
 */
export async function patchActivity(
  userId: string,
  next: Activity,
  expectedUpdatedAt: string,
  options: PatchOptions,
): Promise<void> {
  const userIds = options.indexedUserIds ?? [userId];

  const items: TransactItem[] = [
    {
      Put: {
        Item: stamp(ENTITY.activity, next, { ...activityMeta(next.activityId), ...next }),
        ConditionExpression: '#updatedAt = :expected',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':expected': expectedUpdatedAt },
      },
    },
  ];

  /**
   * **A whole-item `Put`, and never a `Delete` beside it.**
   *
   * P1-09 says a bucket-changing write must "delete and re-put the index entry, not update
   * it". The second half is right and load-bearing; the first half cannot be done, and
   * trying it fails against a real table with *"Transaction request cannot include multiple
   * operations on one item"* — found in P1-09's integration suite, not by reading.
   *
   * The reason is that **the index entry's primary key does not change when its bucket
   * does.** It is `USER#<u>` / `IDX#<activityId>` in every bucket; only the `gsi1pk` and
   * `gsi1sk` *attributes* move. DynamoDB maintains a GSI from the item's current attributes,
   * so replacing the whole item atomically removes the old projection and writes the new
   * one. There is no window and no ghost.
   *
   * What the instruction was protecting against is real and is still avoided: an
   * `UpdateItem` that set some attributes would leave the previous `gsi1pk`/`gsi1sk` in
   * place, and the row would sit in the old bucket for ever. `indexItem` rebuilds every
   * attribute from the activity, so a field dropped from the activity is dropped from the
   * projection too — including the GSI keys themselves, which is how §3.5's archival sweep
   * removes a row from its bucket entirely.
   *
   * A genuine `Delete` of an index entry does exist — when a **participant is removed** and
   * their entry must go (Phase 6). That is a different item in a different partition, not
   * this one.
   */
  for (const indexedUserId of userIds) {
    items.push({ Put: { Item: indexItem(indexedUserId, next, options.taskSubtitle) } });
  }

  if (options.updateChildPointer === true && next.parentActivityId !== undefined) {
    items.push({
      Update: {
        Key: childPointer(next.parentActivityId, next.activityId),
        UpdateExpression:
          'SET #title = :title, #status = :status, #updatedAt = :updatedAt',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: {
          '#title': 'title',
          '#status': 'status',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':title': next.title,
          ':status': next.status,
          ':updatedAt': next.updatedAt,
        },
      },
    });
  }

  const occurrenceGuardIndex =
    options.requireMissingOccurrenceDate === undefined ? undefined : items.length;
  if (options.requireMissingOccurrenceDate !== undefined) {
    items.push({
      ConditionCheck: {
        Key: occurrence(next.activityId, options.requireMissingOccurrenceDate),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
  }

  const conversionGuardIndex =
    options.occurrenceGuard === undefined ? undefined : items.length;
  if (options.occurrenceGuard !== undefined) {
    const guard = options.occurrenceGuard;
    items.push({
      ConditionCheck: {
        Key: occurrence(next.activityId, guard.date),
        ConditionExpression:
          guard.kind === 'missing'
            ? 'attribute_not_exists(pk)'
            : '#updatedAt = :expected',
        ...(guard.kind === 'missing'
          ? {}
          : {
              ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
              ExpressionAttributeValues: { ':expected': guard.updatedAt },
            }),
      },
    });
  }

  const builder = new TransactionBuilder(
    'patchActivity',
    options.idempotencyReceipt === undefined ? 0 : 1,
  ).add(...items);
  if (options.idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(options.idempotencyReceipt));
  }

  await transactWrite(builder.build(), {
    operation: 'patchActivity',
    onConditionFailed: (index) => {
      if (index === occurrenceGuardIndex) {
        return new AppError(
          'validation_failed',
          "Today's occurrence already has history. Change repeat from the next occurrence instead.",
        );
      }
      if (index === conversionGuardIndex) {
        return new AppError(
          'conflict',
          'This occurrence changed while repeat was being updated. Try again.',
        );
      }
      return options.idempotencyReceipt === undefined
        ? undefined
        : new IdempotencyRaceError();
    },
  });
}

export interface ScheduleWriteOptions {
  readonly previous: Activity;
  readonly indexedUserIds: readonly string[];
  readonly participantRows?: readonly StoredItem[];
  readonly taskSubtitle?: string;
  readonly idempotencyReceipt: IdempotencyReceipt;
  readonly cleanupWork?: CleanupWork;
  readonly rsvpResetPending?: boolean;
}

/** Atomically rewrites schedule state and every transaction-coupled projection. */
export async function writeSchedule(
  next: Activity,
  options: ScheduleWriteOptions,
): Promise<void> {
  const items: TransactItem[] = [
    {
      Put: {
        Item: stamp(ENTITY.activity, next, {
          ...activityMeta(next.activityId),
          ...next,
          ...(options.rsvpResetPending === true ? { rsvpResetPending: true } : {}),
        }),
        ConditionExpression: '#updatedAt = :expected',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':expected': options.previous.updatedAt },
      },
    },
  ];

  for (const indexedUserId of new Set(options.indexedUserIds)) {
    items.push({ Put: { Item: indexItem(indexedUserId, next, options.taskSubtitle) } });
  }
  for (const row of options.participantRows ?? []) {
    items.push({ Put: { Item: { ...row, updatedAt: next.updatedAt } } });
  }
  if (next.parentActivityId !== undefined && next.status !== options.previous.status) {
    items.push({
      Update: {
        Key: childPointer(next.parentActivityId, next.activityId),
        UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':status': next.status,
          ':updatedAt': next.updatedAt,
        },
      },
    });
  }

  const reserved = options.cleanupWork === undefined ? 1 : 2;
  const builder = new TransactionBuilder('writeSchedule', reserved).add(...items);
  const receiptIndex = builder.length;
  builder.addReserved(
    receiptItem(options.idempotencyReceipt),
    ...(options.cleanupWork === undefined ? [] : [cleanupItem(options.cleanupWork)]),
  );
  await transactWrite(builder.build(), {
    operation: 'writeSchedule',
    onConditionFailed: (index) =>
      index === receiptIndex ? new IdempotencyRaceError() : undefined,
  });
}

export type ScheduleCleanupKind =
  | 'delete_reminders'
  | 'normalise_untimed_reminders'
  | 'reset_rsvp';

/** One deterministic cleanup page; the cursor is the last processed sort key. */
export async function listScheduleCleanupBatch(
  activityId: string,
  kind: ScheduleCleanupKind,
  cursor?: string,
): Promise<{ rows: StoredItem[]; complete: boolean }> {
  const partition = await getActivityPartition(activityId);
  const entity = kind === 'reset_rsvp' ? 'Participant' : 'Reminder';
  const candidates = partition
    .filter(
      (row) =>
        row.entity === entity &&
        typeof row.sk === 'string' &&
        (cursor === undefined || row.sk > cursor),
    )
    .sort((left, right) => String(left.sk).localeCompare(String(right.sk)));
  return { rows: candidates.slice(0, 25), complete: candidates.length <= 25 };
}

/** Applies one already-decided cleanup page; rows retain their repository-owned keys. */
export async function writeScheduleCleanupBatch(
  activityId: string,
  rows: readonly StoredItem[],
  options: { readonly deleteRows?: boolean; readonly clearRsvpPending?: boolean },
): Promise<void> {
  const items: TransactItem[] = rows.map((row) =>
    options.deleteRows === true
      ? { Delete: { Key: storedItemKey.parse(row) } }
      : { Put: { Item: row } },
  );
  if (options.clearRsvpPending === true) {
    items.push({
      Update: {
        Key: activityMeta(activityId),
        UpdateExpression: 'REMOVE rsvpResetPending',
      },
    });
  }
  await transactWrite(items, { operation: 'writeScheduleCleanupBatch' });
}

/**
 * Appends the Activity and all of its index projections to an originating domain
 * transaction after discussion activity (`data-model.md` §3.5).
 *
 * This helper performs no read and sends no transaction. RSVP, update, and expense writers
 * already hold the complete Activity and participant user-id set; keeping composition here
 * prevents those services from rebuilding GSI keys or touching `updatedAt`.
 */
export function touchLastActivity(
  activity: Activity,
  at: string,
  indexedUserIds: readonly string[],
  tx: TransactItem[],
): Activity {
  const touched: Activity = { ...activity, lastActivityAt: at };

  tx.push({
    Put: {
      Item: stamp(ENTITY.activity, touched, {
        ...activityMeta(touched.activityId),
        ...touched,
      }),
      ConditionExpression: '#updatedAt = :expected',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':expected': activity.updatedAt },
    },
  });

  for (const indexedUserId of new Set(indexedUserIds)) {
    tx.push({ Put: { Item: indexItem(indexedUserId, touched) } });
  }

  return touched;
}

/**
 * Deletes the whole `ACT#<id>` partition and every index entry pointing at it.
 *
 * **Batched, not transactional, and deliberately.** A partition with many participants and
 * many updates exceeds a transaction's 100 items, and a transaction that can never succeed
 * leaves the user unable to delete anything at all. A partially deleted activity is
 * recoverable by re-running the delete, which is why P1-14's handler is idempotent.
 *
 * Clearing pointers on things that point *back* — a child's `parentActivityId`, list links,
 * expense locators — is P1-14's cascade, not this method's: those live in other partitions
 * and each has its own rule about whether it survives.
 */
export interface DeleteOptions {
  /** Owner plus every participating app user. Phase 6 supplies more than one. */
  readonly indexedUserIds?: readonly string[];
  /**
   * The partition as the caller already read it.
   *
   * Added in P1-14, whose cascade has to read it anyway — the `SUB#` pointers are how it
   * finds the prep tasks whose `parentActivityId` it must clear. Without this the delete
   * costs three round trips against a budget of three (`definition-of-done.md` §6): the
   * access check, the cascade's read, and this one re-reading the same rows.
   */
  readonly partition?: readonly StoredItem[];
  /** The delete instant, so the tombstone's `deletedAt` and `ttl` are testable. */
  readonly now?: string;
}

export async function deleteActivity(
  userId: string,
  activityId: string,
  options: DeleteOptions = {},
): Promise<void> {
  const indexedUserIds = options.indexedUserIds ?? [];
  const partition = options.partition ?? (await getActivityPartition(activityId));

  const metaKey = activityMeta(activityId);
  const keys = partition
    .map((item) => storedItemKey.parse(item))
    .filter((key) => key.pk !== metaKey.pk || key.sk !== metaKey.sk);

  for (const indexedUserId of new Set([userId, ...indexedUserIds])) {
    keys.push(activityIndex(indexedUserId, activityId));
  }

  // META is the authority seam. Everything else goes first so an interrupted delete can
  // still authenticate a retry and finish cleanup; once META is gone, cleanup is complete.
  await deleteAll(keys);

  /**
   * META's removal and the tombstone's arrival are **one transaction** (Phase 2.6).
   *
   * Between the two there must be no instant where the id is neither alive nor tombstoned: a
   * queued create replayed in that window would find no `META` to collide with and no
   * tombstone to stop it, and would resurrect an entity the user deleted. Batching them
   * separately would leave exactly that window open.
   */
  const deletedAt = options.now ?? new Date().toISOString();
  await transactWrite(
    new TransactionBuilder('deleteActivity', 0)
      .add(
        { Delete: { Key: metaKey } },
        {
          Put: {
            Item: {
              ...activityTombstone(activityId),
              entity: ENTITY.tombstone,
              activityId,
              ownerId: userId,
              deletedAt,
              /**
               * Seconds, as DynamoDB TTL requires. Bounded by the **same** constant that
               * bounds the client's automatic replay, imported rather than restated, so the
               * two windows cannot drift apart: a tombstone is guaranteed to outlive every
               * intent still eligible to replay against it. DynamoDB deletes expired items
               * lazily, which is extra slack and never part of the margin.
               */
              ttl:
                Math.floor(Date.parse(deletedAt) / 1000) +
                MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60,
              schemaVersion: SCHEMA_VERSION,
            },
          },
        },
      )
      .build(),
    { operation: 'deleteActivity' },
  );
}

export interface ListOptions {
  /** Inclusive `gsi1sk` bounds. Pattern 1's date window uses `<from>T00:00`/`<to>T23:59`. */
  readonly between?: readonly [string, string];
  readonly cursor?: string;
  readonly limit?: number;
  /** `false` reads newest-first — what Needs a date and Plans → Past want. */
  readonly ascending?: boolean;
}

/**
 * One GSI1 bucket for one user (patterns 1, 2 and 3).
 *
 * Bucket-shaped rather than filter-shaped on purpose. `api-contract.md` names
 * `?filter=inbox|upcoming|past|saved` on `GET /v1/activities` but never defines what those
 * map to; inventing the mapping here would bury a product decision in the storage layer.
 * P1-16 owns it, and composes it from these.
 */
export async function listByBucket(
  userId: string,
  bucket: Gsi1Bucket,
  options: ListOptions = {},
): Promise<Page<StoredItem>> {
  return query<StoredItem>(gsi1BucketKey(userId, bucket), {
    indexName: TABLE.indexes[0].name,
    ...(options.between === undefined ? {} : { skBetween: options.between }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.ascending === undefined ? {} : { ascending: options.ascending }),
    keyAttributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'],
  });
}

/**
 * Reads the bounded scheduled-index window that may roll forward onto Today.
 *
 * The repository owns the stable index predicates. Completed rows remain candidates because
 * the Agenda service may retain one completed today in Earlier Today; it applies that
 * timezone-sensitive predicate after hydrating `completedAt` from META.
 */
export async function listOverdueTaskCandidates(
  userId: string,
  from: string,
  to: string,
): Promise<StoredItem[]> {
  const rows = await queryAll<StoredItem>(gsi1BucketKey(userId, 'S'), {
    indexName: TABLE.indexes[0].name,
    skBetween: [`${from}T00:00`, `${to}T23:59`],
    keyAttributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'],
  });

  return rows.filter(
    (row) =>
      row.type === 'task' &&
      (row.status === 'scheduled' || row.status === 'completed') &&
      row.isRecurring === false,
  );
}

/** A plan's prep-task pointers (pattern 16). */
export async function listChildPointers(activityId: string): Promise<StoredItem[]> {
  const prefix = childPointerPrefix(activityId);
  return queryAll<StoredItem>({ pk: prefix.pk }, { skPrefix: prefix.skPrefix });
}
