import {
  assertNever,
  MAX_AUTOMATIC_INTENT_AGE_DAYS,
  MAX_PREP_TASKS_PER_PLAN,
} from '@od/shared';
import { deriveGsi1Bucket } from '@od/shared/activity';
import { activity as activitySchema } from '@od/shared/schemas';
import { TABLE } from '@od/shared/table';
import type {
  Activity,
  ActivitySchedule,
  Gsi1Bucket,
  ListItemActivityLink,
  Reminder,
} from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import {
  type CleanupWork,
  IdempotencyRaceError,
  type IdempotencyReceipt,
} from '../lib/idempotency.js';
import {
  batchGetItems,
  deleteAll,
  getItem,
  type Page,
  query,
  queryAll,
  updateItem,
} from './base.js';
import { cleanupItem, receiptItem } from './idempotencyRepository.js';
import {
  activityIndex,
  activityMeta,
  activityPartition,
  activityTombstone,
  attachment as attachmentKey,
  childPointer,
  childPointerPrefix,
  gsi1Anytime,
  gsi1Bucket as gsi1BucketKey,
  gsi1NeedsDate,
  gsi1Recurring,
  gsi1Scheduled,
  listItemActivityLink,
  occurrence,
  participantPrefix,
  pendingUpload as pendingUploadKey,
  reminder as reminderKey,
} from './keys.js';
import { listItemActivityLinkRow } from './listLinkRow.js';
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

/**
 * A parent plan would not take another prep task — it is full, or it is no longer there.
 *
 * Thrown from the **transaction**, not from a precheck, which is the whole point: a service
 * that has read `childCount` and found room can still lose to a create that commits between
 * the read and the write, and only a condition on the parent's own counter closes that
 * window (the lesson P3-05's precheck-only list cap is still carrying). The service turns it
 * into caller-facing copy after re-reading the parent, because the two causes deserve
 * different answers and this layer decides nothing.
 */
export class ParentUnavailableError extends Error {
  constructor() {
    super('The parent plan would not accept this prep task.');
    this.name = 'ParentUnavailableError';
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
  /**
   * The caller's `ListItemActivityLink`, written in **this** transaction (P3-13).
   *
   * The bridge's Plan and the pointer that makes it reachable from the item are one atomic
   * unit: a Plan committed without its pointer is a Plan the list can never show, and a
   * pointer committed without its Plan is a dead link. Same key per viewer, so a later
   * confirmed action replaces only this caller's pointer and never another member's
   * (ADR-034).
   *
   * The `ITEM#` row is not here, and that is the point — the item is not copied, moved,
   * checked, hidden or given an Activity id (`agent-playbook.md` §6.8).
   */
  readonly listItemLink?: ListItemActivityLink;
  /** Pending uploads durably targeted at this Activity in the create transaction. */
  readonly confirmAttachmentIds?: readonly string[];
}

export class PendingAttachmentsUnavailableError extends Error {
  constructor() {
    super('One or more pending uploads can no longer be confirmed.');
    this.name = 'PendingAttachmentsUnavailableError';
  }
}

/**
 * The parent's thin pointer to one prep task (`data-model.md` §3.1).
 *
 * It mirrors `title`, `status` and `isRecurring` so plan detail renders the PREP section from
 * one bounded prefix `Query` with no child lookup, and so the completion follow-up can count
 * and act on incomplete **one-off** children without inferring an occurrence for a recurring
 * one. Every writer of those three fields writes this row in the same transaction; the child
 * Activity stays the source of truth.
 */
function childPointerPut(
  parentActivityId: string,
  activity: Activity,
  rank?: string,
): TransactItem {
  return {
    Put: {
      Item: stamp(ENTITY.childPointer, activity, {
        ...childPointer(parentActivityId, activity.activityId),
        childActivityId: activity.activityId,
        title: activity.title,
        status: activity.status,
        rank: rank ?? activity.createdAt,
        isRecurring: activity.recurrence !== undefined,
      }),
    },
  };
}

/**
 * Moves a parent's denormalised `childCount` by one, in the transaction that adds or removes
 * the pointer it counts.
 *
 * **`ADD`, and it does not touch the parent's `updatedAt`.** The counter is a denormalised
 * count of other rows rather than an edit to the plan: bumping the plan's concurrency token
 * because somebody added a prep task would `409` an unrelated `If-Match` edit of the plan
 * itself, and `IndexProjection` carries no `childCount`, so no index entry needs rewriting
 * either. `ADD` also means two concurrent children each apply their own delta rather than one
 * overwriting the other's read-modify-write.
 *
 * The conditions are what make it a **cap** rather than a hopeful check. `attribute_exists`
 * keeps an `ADD` against a deleted parent from conjuring a stub item at that key — an
 * `UpdateItem` creates the row it cannot find — and the upper bound refuses the 51st child at
 * the only point where the count is authoritative. Going below zero is refused for the
 * mirror-image reason: a replayed decrement must not invent debt.
 */
function childCountDelta(parentActivityId: string, delta: 1 | -1): TransactItem {
  return {
    Update: {
      Key: activityMeta(parentActivityId),
      UpdateExpression: 'ADD #childCount :delta',
      /**
       * The increment also requires the parent to **still be a Plan**, which is the other
       * half of the conversion race (P3-18 review).
       *
       * `childCount` moves by `ADD` and deliberately does not touch `updatedAt`, so the
       * Plan → Task conversion's `updatedAt` condition cannot see an attach that lands
       * between its read and its write. Both sides therefore condition on what the other
       * one changes: the conversion pins the `childCount` it validated, and the attach pins
       * the `objectKind` it read. Neither can commit on top of the other, and a caller that
       * loses re-reads rather than being told a lie about a parent that has since changed
       * kind. The **decrement** is deliberately not gated this way — a child leaving a
       * parent that is somehow no longer a Plan must still be able to clean up after itself.
       */
      ConditionExpression:
        delta === 1
          ? 'attribute_exists(pk) AND #childCount < :cap AND #objectKind = :plan'
          : 'attribute_exists(pk) AND #childCount > :zero',
      ExpressionAttributeNames:
        delta === 1
          ? { '#childCount': 'childCount', '#objectKind': 'objectKind' }
          : { '#childCount': 'childCount' },
      ExpressionAttributeValues:
        delta === 1
          ? { ':delta': 1, ':cap': MAX_PREP_TASKS_PER_PLAN, ':plan': 'plan' }
          : { ':delta': -1, ':zero': 0 },
    },
  };
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

  if (options.listItemLink !== undefined) {
    items.push({
      Put: { Item: listItemActivityLinkRow(options.listItemLink, activity.createdAt) },
    });
  }

  const parentCounterIndex =
    activity.parentActivityId === undefined ? undefined : items.length + 1;
  if (activity.parentActivityId !== undefined) {
    items.push(
      childPointerPut(activity.parentActivityId, activity, options.childPointerRank),
      childCountDelta(activity.parentActivityId, 1),
    );
  }

  const confirmationIndices = new Set<number>();
  for (const attachmentId of options.confirmAttachmentIds ?? []) {
    confirmationIndices.add(items.length);
    items.push({
      Update: {
        Key: pendingUploadKey(userId, attachmentId),
        UpdateExpression: 'SET #state = :confirming, #activityId = :activityId',
        ConditionExpression:
          'attribute_exists(pk) AND (#state = :awaiting OR (#state = :confirming AND #activityId = :activityId))',
        ExpressionAttributeNames: { '#state': 'state', '#activityId': 'activityId' },
        ExpressionAttributeValues: {
          ':confirming': 'confirming',
          ':awaiting': 'awaiting_upload',
          ':activityId': activity.activityId,
        },
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
      if (index === parentCounterIndex) return new ParentUnavailableError();
      if (confirmationIndices.has(index)) return new PendingAttachmentsUnavailableError();
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

/**
 * The `META` row alone, for the paths that do not need the whole partition.
 *
 * `consistentRead` is not decoration on the two paths that pass it. A default-consistency
 * `GetItem` may miss a row that was committed moments ago, and a caller that treats the miss
 * as **absence** then acts on it: the orphaning pass would skip a child it could not see and
 * delete its parent anyway, leaving a `parentActivityId` pointing at nothing, and the
 * counter-conflict classifier would tell a client the plan was deleted when it is merely
 * full. Where a miss decides something destructive or user-visible, the read has to be
 * authoritative (`data-model.md` §5).
 */
export async function getActivityMeta(
  activityId: string,
  options: { readonly consistentRead?: boolean } = {},
): Promise<Activity | undefined> {
  return getItem<Activity & StoredItem>(activityMeta(activityId), options);
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
      ConditionExpression:
        '#updatedAt = :expected AND #lastActivityAt = :expectedLastActivityAt AND #participantCount = :expectedParticipantCount AND #childCount = :expectedChildCount AND #expenseTotalCents = :expectedExpenseTotalCents AND attribute_not_exists(#deletingAt)',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
        '#lastActivityAt': 'lastActivityAt',
        '#participantCount': 'participantCount',
        '#childCount': 'childCount',
        '#expenseTotalCents': 'expenseTotalCents',
        '#deletingAt': 'deletingAt',
      },
      ExpressionAttributeValues: {
        ':expected': expectedUpdatedAt,
        ':expectedLastActivityAt': next.lastActivityAt,
        ':expectedParticipantCount': next.participantCount,
        ':expectedChildCount': next.childCount,
        ':expectedExpenseTotalCents': next.expenseTotalCents,
      },
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
export async function listParticipants(
  activityId: string,
  options: { readonly consistentRead?: boolean } = {},
): Promise<StoredItem[]> {
  const prefix = participantPrefix(activityId);
  return queryAll<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      ...(options.consistentRead === true ? { consistentRead: true } : {}),
    },
  );
}

/**
 * A viewer pointer moved between being read and being cleared (P3-15).
 *
 * **Not the caller's problem, and never their error.** The pointer condition exists to
 * protect a *newer* Plan somebody just made; letting it cancel the transaction would mean
 * the user's skip silently did not happen because an unrelated pointer changed. The service
 * re-reads the pointers and retries, and the retry no longer names the replaced one.
 */
export class StaleViewerLinkError extends Error {
  constructor() {
    super('A viewer link changed while it was being cleared.');
    this.name = 'StaleViewerLinkError';
  }
}

export interface PatchOptions extends CreateOptions {
  /**
   * The index entry as it is **now**, so a bucket change can delete the old row in the same
   * transaction that writes the new one. Supply the activity as it was read.
   */
  readonly previous: Activity;
  /** Owner plus every participating app user. Phase 6 supplies more than one. */
  readonly indexedUserIds?: readonly string[];
  /**
   * Keep the parent side of a prep task in step with this write, in the same transaction.
   *
   * Two shapes, chosen from `previous.parentActivityId` versus `next.parentActivityId` rather
   * than from a second flag, because they are the same obligation: **the pointer never
   * disagrees with the child.** Same parent refreshes the denormalised title, status and
   * recurrence bit; a changed parent moves the pointer and both counters.
   */
  readonly updateChildPointer?: boolean;
  /** A same-day recurrence correction is valid only while that date has no stored history. */
  readonly requireMissingOccurrenceDate?: string;
  /** Pins the selected occurrence read by an atomic series-to-one-off conversion. */
  readonly occurrenceGuard?:
    | { readonly date: string; readonly kind: 'missing' }
    | { readonly date: string; readonly kind: 'version'; readonly updatedAt: string };
  /**
   * Viewer pointers to clear **in this transaction** (P3-15).
   *
   * A non-occurrence transition to `skipped` and Plan → Task conversion supply these. The
   * lifecycle table clears pointers when a Plan is skipped, and a conversion removes the
   * Plan-specific relationship and Activity provenance. Atomic with the Activity write
   * because either transition committed without its pointer clearing would leave hidden or
   * misleading List state.
   *
   * Each delete is conditional on the pointer still naming this Activity, so a viewer who
   * planned the item again in the meantime keeps the newer pointer.
   */
  readonly clearViewerLinks?: readonly ListItemActivityLink[];
  /**
   * Pin the `childCount` this write was authorised against (P3-18 review).
   *
   * `updatedAt` is not a sufficient concurrency token for a decision made about
   * `childCount`, because the counter moves by `ADD` and deliberately leaves `updatedAt`
   * alone — that is what stops a prep task being added from 409ing an unrelated open editor.
   * The cost is that a Plan → Task conversion, which is legal only at `childCount === 0`,
   * cannot see an attach that lands between its read and its write: the stale whole-item
   * `Put` still satisfies `updatedAt` and would reinstate `childCount: 0` on a parent that
   * now has a child, leaving the child and its `SUB#` pointer attached to a Task.
   *
   * So the conversion pins the number instead. Supplied only by the path whose authorisation
   * depends on it; every other patch leaves it absent and is unaffected.
   */
  readonly expectedChildCount?: number;
  /**
   * Items the caller needs committed **with** this patch (P3-19).
   *
   * The feed's system entry for a completion uses it, for the same reason the schedule path
   * does: a completion that committed while its feed row failed would leave the two
   * disagreeing, and the feed's only job is to agree with the plan. Opaque here by design —
   * the repository composes what it is handed and never learns the feed's row shape.
   */
  readonly extraItems?: readonly TransactItem[];
  /** Rebuilds an idempotency receipt if a discussion-state retry changes the response. */
  readonly idempotencyReceiptFor?: (activity: Activity) => IdempotencyReceipt;
  /** A non-null cover selection, condition-checked against the linked row atomically. */
  readonly coverAttachmentId?: string;
}

export class CoverAttachmentUnavailableError extends Error {
  constructor() {
    super('The selected cover attachment is no longer linked.');
    this.name = 'CoverAttachmentUnavailableError';
  }
}

const ACTIVITY_META_MERGE_ATTEMPTS = 3;

type IndependentActivityState = Pick<
  Activity,
  'lastActivityAt' | 'participantCount' | 'childCount' | 'expenseTotalCents'
>;

function independentActivityState(activity: Activity): IndependentActivityState {
  return {
    lastActivityAt: activity.lastActivityAt,
    participantCount: activity.participantCount,
    childCount: activity.childCount,
    expenseTotalCents: activity.expenseTotalCents,
  };
}

function independentStateMoved(
  expected: IndependentActivityState,
  fresh: Activity,
): boolean {
  return (
    fresh.lastActivityAt !== expected.lastActivityAt ||
    fresh.participantCount !== expected.participantCount ||
    fresh.childCount !== expected.childCount ||
    fresh.expenseTotalCents !== expected.expenseTotalCents
  );
}

function mergeIndependentState(next: Activity, fresh: Activity): void {
  next.lastActivityAt = fresh.lastActivityAt;
  next.participantCount = fresh.participantCount;
  next.childCount = fresh.childCount;
  next.expenseTotalCents = fresh.expenseTotalCents;
}

class ActivityMetaConflictError extends Error {
  constructor() {
    super('The Activity META condition changed.');
    this.name = 'ActivityMetaConflictError';
  }
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
  let expectedIndependent: IndependentActivityState = {
    ...independentActivityState(options.previous),
    ...(options.expectedChildCount === undefined
      ? {}
      : { childCount: options.expectedChildCount }),
  };

  for (let attempt = 0; attempt < ACTIVITY_META_MERGE_ATTEMPTS; attempt += 1) {
    try {
      await patchActivityOnce(
        userId,
        next,
        expectedUpdatedAt,
        expectedIndependent,
        options,
      );
      return;
    } catch (error) {
      if (!(error instanceof ActivityMetaConflictError)) throw error;

      const fresh = await getActivityMeta(next.activityId, { consistentRead: true });
      if (fresh === undefined || fresh.updatedAt !== expectedUpdatedAt) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }

      if (!independentStateMoved(expectedIndependent, fresh)) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }

      /**
       * `indexedUserIds` was resolved from the participant set beside `previous`. If that set
       * moved, retrying it would rewrite only the stale viewers' projections and omit a new
       * participant (or recreate a removed one's row). The service must resolve access and
       * viewers again; only scalar state that does not change the write set is mergeable here.
       */
      if (fresh.participantCount !== expectedIndependent.participantCount) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }

      /**
       * A Plan -> Task conversion made a decision from all three counters. If any changed,
       * the service must re-run the blocker rule against the fresh row rather than merging a
       * value that may make the conversion illegal. Ordinary edits depend on none of them,
       * so they may preserve the fresh values and continue without a false client conflict.
       */
      if (
        options.expectedChildCount !== undefined &&
        (fresh.childCount !== expectedIndependent.childCount ||
          fresh.expenseTotalCents !== expectedIndependent.expenseTotalCents)
      ) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }

      mergeIndependentState(next, fresh);
      expectedIndependent = independentActivityState(fresh);
    }
  }

  throw new AppError(
    'conflict',
    'This changed while you were editing it. Review the update.',
  );
}

async function patchActivityOnce(
  userId: string,
  next: Activity,
  expectedUpdatedAt: string,
  expectedIndependent: IndependentActivityState,
  options: PatchOptions,
): Promise<void> {
  const userIds = options.indexedUserIds ?? [userId];

  const items: TransactItem[] = [
    {
      Put: {
        Item: stamp(ENTITY.activity, next, { ...activityMeta(next.activityId), ...next }),
        ConditionExpression:
          '#updatedAt = :expected AND #lastActivityAt = :expectedLastActivityAt AND #participantCount = :expectedParticipantCount AND #childCount = :expectedChildCount AND #expenseTotalCents = :expectedExpenseTotalCents AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#lastActivityAt': 'lastActivityAt',
          '#participantCount': 'participantCount',
          '#childCount': 'childCount',
          '#expenseTotalCents': 'expenseTotalCents',
          '#deletingAt': 'deletingAt',
        },
        ExpressionAttributeValues: {
          ':expected': expectedUpdatedAt,
          ':expectedLastActivityAt': expectedIndependent.lastActivityAt,
          ':expectedParticipantCount': expectedIndependent.participantCount,
          ':expectedChildCount': expectedIndependent.childCount,
          ':expectedExpenseTotalCents': expectedIndependent.expenseTotalCents,
        },
      },
    },
    ...(options.clearViewerLinks ?? []).map(viewerLinkDelete),
  ];
  /**
   * Where the pointer deletes sit, so their condition failure can be told apart from every
   * other one. They are the only items here whose failure is **not** the caller's problem:
   * see {@link StaleViewerLinkError}.
   */
  const viewerLinkIndices = new Set(
    (options.clearViewerLinks ?? []).map((_link, offset) => offset + 1),
  );

  const coverGuardIndex =
    options.coverAttachmentId === undefined ? undefined : items.length;
  if (options.coverAttachmentId !== undefined) {
    items.push({
      ConditionCheck: {
        Key: attachmentKey(next.activityId, options.coverAttachmentId),
        ConditionExpression: 'attribute_exists(pk)',
      },
    });
  }

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

  const counterIndices = new Set<number>();
  if (options.updateChildPointer === true) {
    const before = options.previous.parentActivityId;
    const after = next.parentActivityId;

    if (before === after) {
      if (after !== undefined) {
        items.push({
          Update: {
            Key: childPointer(after, next.activityId),
            UpdateExpression:
              'SET #title = :title, #status = :status, #isRecurring = :isRecurring, #updatedAt = :updatedAt',
            ConditionExpression: 'attribute_exists(pk)',
            ExpressionAttributeNames: {
              '#title': 'title',
              '#status': 'status',
              '#isRecurring': 'isRecurring',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':title': next.title,
              ':status': next.status,
              ':isRecurring': next.recurrence !== undefined,
              ':updatedAt': next.updatedAt,
            },
          },
        });
      }
    } else {
      /**
       * Detaching and attaching are one atomic pair, so a re-parent cannot leave the task on
       * two plans or on none. Both deletes are conditional on the pointer still being there:
       * a decrement whose pointer had already gone would take the count below what the
       * collection holds, and the count is what plan detail renders.
       */
      if (before !== undefined) {
        items.push({
          Delete: {
            Key: childPointer(before, next.activityId),
            ConditionExpression: 'attribute_exists(pk)',
          },
        });
        counterIndices.add(items.length);
        items.push(childCountDelta(before, -1));
      }
      if (after !== undefined) {
        items.push(childPointerPut(after, next));
        counterIndices.add(items.length);
        items.push(childCountDelta(after, 1));
      }
    }
  }

  items.push(...(options.extraItems ?? []));

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
  const receiptIndex = builder.length;
  if (options.idempotencyReceipt !== undefined) {
    builder.addReserved(
      receiptItem(options.idempotencyReceiptFor?.(next) ?? options.idempotencyReceipt),
    );
  }

  await transactWrite(builder.build(), {
    operation: 'patchActivity',
    onConditionFailed: (index) => {
      if (index === 0) return new ActivityMetaConflictError();
      if (viewerLinkIndices.has(index)) return new StaleViewerLinkError();
      if (index === coverGuardIndex) return new CoverAttachmentUnavailableError();
      if (counterIndices.has(index)) return new ParentUnavailableError();
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
      return options.idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined;
    },
  });
}

export interface ScheduleWriteOptions {
  readonly previous: Activity;
  /**
   * Items the caller needs committed **with** the schedule change (P3-19).
   *
   * The feed's system entry uses this: a schedule write that succeeded while its "Date set to
   * Saturday" row failed would leave a feed that disagrees with the plan, and agreeing with
   * the plan is the feed's only job. They join the same transaction rather than following it,
   * so there is no window in which one exists without the other.
   *
   * Deliberately opaque here. The repository does not know what a system entry is and must
   * not — it composes items it is handed, which is what stops this becoming a second place
   * that knows the feed's row shape.
   */
  readonly extraItems?: readonly TransactItem[];
  readonly indexedUserIds: readonly string[];
  readonly participantRows?: readonly StoredItem[];
  readonly taskSubtitle?: string;
  readonly idempotencyReceipt: IdempotencyReceipt;
  /** Rebuilds the stored response when an internal discussion-state retry changes META. */
  readonly idempotencyReceiptFor?: (activity: Activity) => IdempotencyReceipt;
  readonly cleanupWork?: CleanupWork;
  readonly rsvpResetPending?: boolean;
}

/** Atomically rewrites schedule state and every transaction-coupled projection. */
export async function writeSchedule(
  next: Activity,
  options: ScheduleWriteOptions,
): Promise<void> {
  let expectedIndependent = independentActivityState(options.previous);

  for (let attempt = 0; attempt < ACTIVITY_META_MERGE_ATTEMPTS; attempt += 1) {
    try {
      await writeScheduleOnce(next, expectedIndependent, options);
      return;
    } catch (error) {
      if (!(error instanceof ActivityMetaConflictError)) throw error;

      const fresh = await getActivityMeta(next.activityId, { consistentRead: true });
      if (fresh === undefined || fresh.updatedAt !== options.previous.updatedAt) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }
      if (!independentStateMoved(expectedIndependent, fresh)) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }
      if (fresh.participantCount !== expectedIndependent.participantCount) {
        throw new AppError(
          'conflict',
          'This changed while you were editing it. Review the update.',
        );
      }

      mergeIndependentState(next, fresh);
      expectedIndependent = independentActivityState(fresh);
    }
  }

  throw new AppError(
    'conflict',
    'This changed while you were editing it. Review the update.',
  );
}

async function writeScheduleOnce(
  next: Activity,
  expectedIndependent: IndependentActivityState,
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
        ConditionExpression:
          '#updatedAt = :expected AND #lastActivityAt = :expectedLastActivityAt AND #participantCount = :expectedParticipantCount AND #childCount = :expectedChildCount AND #expenseTotalCents = :expectedExpenseTotalCents AND attribute_not_exists(#deletingAt)',
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          '#lastActivityAt': 'lastActivityAt',
          '#participantCount': 'participantCount',
          '#childCount': 'childCount',
          '#expenseTotalCents': 'expenseTotalCents',
          '#deletingAt': 'deletingAt',
        },
        ExpressionAttributeValues: {
          ':expected': options.previous.updatedAt,
          ':expectedLastActivityAt': expectedIndependent.lastActivityAt,
          ':expectedParticipantCount': expectedIndependent.participantCount,
          ':expectedChildCount': expectedIndependent.childCount,
          ':expectedExpenseTotalCents': expectedIndependent.expenseTotalCents,
        },
      },
    },
  ];

  for (const indexedUserId of new Set(options.indexedUserIds)) {
    items.push({ Put: { Item: indexItem(indexedUserId, next, options.taskSubtitle) } });
  }
  for (const row of options.participantRows ?? []) {
    items.push({ Put: { Item: { ...row, updatedAt: next.updatedAt } } });
  }
  items.push(...(options.extraItems ?? []));
  if (next.parentActivityId !== undefined && next.status !== options.previous.status) {
    items.push({
      Update: {
        Key: childPointer(next.parentActivityId, next.activityId),
        UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
        /**
         * The same guard the patch path carries, added in P3-18. An `UpdateItem` **creates**
         * the row it cannot find, so an unconditional status write against a missing pointer
         * would conjure a stub carrying a status and nothing else — a child in the plan's
         * count with no id, no title and no recurrence bit, which the bounded collection read
         * would then hand to plan detail.
         */
        ConditionExpression: 'attribute_exists(pk)',
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
    receiptItem(options.idempotencyReceiptFor?.(next) ?? options.idempotencyReceipt),
    ...(options.cleanupWork === undefined ? [] : [cleanupItem(options.cleanupWork)]),
  );
  await transactWrite(builder.build(), {
    operation: 'writeSchedule',
    onConditionFailed: (index) => {
      if (index === 0) return new ActivityMetaConflictError();
      return index === receiptIndex ? new IdempotencyRaceError() : undefined;
    },
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
    Update: {
      Key: activityMeta(touched.activityId),
      UpdateExpression: 'SET #lastActivityAt = :at',
      /**
       * **Both timestamps**, and the second one is not redundant (P3-19 review).
       *
       * `updatedAt` alone cannot serialise two concurrent discussion writes, because neither
       * of them moves it — that is the whole point of the split. Two posts read the same
       * `updatedAt`; the later one commits; the earlier one then passes an `updatedAt`
       * condition that nothing has changed and sets META to its **older**
       * `lastActivityAt`. Both entries survive, but the plan walks backwards down Needs a
       * date and the timestamp the first response called authoritative is now a lie.
       *
       * So the write also pins the `lastActivityAt` it read. The loser's condition fails, and
       * its caller retries from fresh META — which is where the value it must not regress is.
       * It is a field-level `Update`, not a whole-row `Put`, so an independently committed
       * participant, prep-task or expense counter cannot be rolled back by the stale META
       * snapshot from which this discussion write was composed.
       */
      ConditionExpression:
        '#updatedAt = :expected AND #lastActivityAt = :expectedLast AND attribute_not_exists(#deletingAt)',
      ExpressionAttributeNames: {
        '#updatedAt': 'updatedAt',
        '#lastActivityAt': 'lastActivityAt',
        '#deletingAt': 'deletingAt',
      },
      ExpressionAttributeValues: {
        ':expected': activity.updatedAt,
        ':expectedLast': activity.lastActivityAt,
        ':at': at,
      },
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
  /**
   * Viewer pointers to this Plan, cleared **before** META (P3-15).
   *
   * They live in the list's partition rather than this Activity's, so the ordinary cascade —
   * which collects this partition's own rows — never saw them. Before META, for the same
   * reason everything else is: until META goes, an interrupted delete can re-authorise and
   * resume, and a pointer left behind after META would be a dead link nothing could clean up.
   */
  readonly clearViewerLinks?: readonly ListItemActivityLink[];
}

/**
 * Closes the create/link-versus-delete race before the delete snapshots the partition.
 * Link transactions condition-check this marker, so every link either precedes the marker
 * and is included in the snapshot, or follows it and is rejected.
 */
export async function markActivityDeleting(
  userId: string,
  activityId: string,
  now: string,
): Promise<void> {
  await updateItem(activityMeta(activityId), {
    expression: 'SET #deletingAt = if_not_exists(#deletingAt, :now)',
    names: { '#deletingAt': 'deletingAt', '#ownerId': 'ownerId' },
    values: { ':now': now, ':userId': userId },
    condition: 'attribute_exists(pk) AND #ownerId = :userId',
  });
}

/**
 * One conditional pointer removal, shared by the skip transition and the delete cascade.
 *
 * **Conditional on the `activityId` the caller observed**, which is the table's "delete only
 * `LNK#` rows that **still point to it**" in one expression: a viewer who has since planned
 * the item again owns a pointer to a different Plan, and neither a skip nor a delete of the
 * older one may touch it.
 */
function viewerLinkDelete(link: ListItemActivityLink): TransactItem {
  return {
    Delete: {
      Key: listItemActivityLink(link.listId, link.viewerUserId, link.itemId),
      ConditionExpression: '#activityId = :activityId',
      ExpressionAttributeNames: { '#activityId': 'activityId' },
      ExpressionAttributeValues: { ':activityId': link.activityId },
    },
  };
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

  /**
   * The list's viewer pointers, each conditional on still naming this Plan. A condition
   * failure means the viewer planned the item again and that newer pointer stands, so it is
   * swallowed rather than failing a delete that has already been authorised.
   */
  for (const link of options.clearViewerLinks ?? []) {
    try {
      await transactWrite([viewerLinkDelete(link)], { operation: 'clearViewerLink' });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
    }
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

/**
 * Every row of a plan's prep-task prefix, unbounded — the **delete cascade's** reader.
 *
 * `queryAll` is legitimate here and nowhere else on this prefix: the cascade must clear
 * `parentActivityId` on every child that exists, including the ones a legacy or
 * partially-migrated partition holds beyond today's cap, and missing one would leave a task
 * pointing at an activity that no longer exists. The **detail** path is
 * {@link listPrepTaskPointers}, which is bounded by the model cap and is the complete
 * collection by construction (pattern 16).
 */
export async function listChildPointers(activityId: string): Promise<StoredItem[]> {
  const prefix = childPointerPrefix(activityId);
  return queryAll<StoredItem>({ pk: prefix.pk }, { skPrefix: prefix.skPrefix });
}

/**
 * One prep task, as its parent's pointer projects it.
 *
 * Parsed rather than cast, like every other stored row this file returns. A pointer that has
 * lost a field it has carried since P1-09 is a denormalisation bug, and the read that feeds
 * `3 of 5 done` is the wrong place to paper over one with a default — the number would be
 * wrong and nothing would say so. `isRecurring` is the one exception, and a documented one:
 * rows written before P3-18 do not carry it, and absent means `false`.
 */
const prepTaskPointerRow = z.object({
  childActivityId: z.string(),
  title: z.string(),
  status: z.enum(['saved', 'scheduled', 'completed', 'skipped', 'cancelled']),
  rank: z.string(),
  isRecurring: z.boolean().optional(),
});

export interface PrepTaskPointer {
  readonly childActivityId: string;
  readonly title: string;
  readonly status: Activity['status'];
  readonly rank: string;
  readonly isRecurring: boolean;
}

/**
 * A plan's complete prep-task collection, in **one bounded `Query`** (pattern 16).
 *
 * `Limit` is the model cap, and that is the whole design: creation refuses the 51st child, so
 * a single page **is** the collection and there is no cursor, no second read and no
 * `queryAll` on a prefix the detail path touches. The data model names a GSI alternative and
 * rejects it; do not reach for it here.
 *
 * **Strongly consistent**, because both named consumers act on what they read. Plan detail's
 * `3 of 5 done` is composed inside an authoritative read (pattern 4), and the completion
 * follow-up (P3-43) counts children immediately after a write that may have changed one of
 * these very pointers. An eventually consistent page would show the user a ratio that
 * disagrees with the rows underneath it.
 *
 * `isRecurring` reads **absent as `false`**: pointers written before P3-18 carry no such
 * attribute, and a missing bit means the child was never given recurrence through a writer
 * that maintains it. Treating absence as `true` would silently drop a real one-off child out
 * of the follow-up's count.
 */
export async function listPrepTaskPointers(
  activityId: string,
): Promise<PrepTaskPointer[]> {
  const prefix = childPointerPrefix(activityId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_PREP_TASKS_PER_PLAN,
      consistentRead: true,
    },
  );

  return page.items.map((row) => {
    const pointer = prepTaskPointerRow.parse(row);
    return { ...pointer, isRecurring: pointer.isRecurring ?? false };
  });
}

/**
 * Removes one prep task from its parent — the pointer and the count, **together**.
 *
 * The pair is a transaction because a count that outlives its pointer is a plan claiming a
 * prep task that plan detail cannot show, and the ratio it renders is the number a user is
 * expected to trust. This is the half of the delete cascade that lives in the *parent's*
 * partition, which is why P1-14's own removal — which deletes the child's partition and its
 * index rows — never saw it and left both behind.
 *
 * A condition failure means the pointer has already gone: a retry of an interrupted delete,
 * or a parent removed in between. Swallowed rather than raised, so the retry that finishes
 * the cascade is not blocked by the step that already succeeded, and so the decrement can
 * never be applied twice for one pointer.
 */
export async function detachChildFromParent(
  parentActivityId: string,
  childActivityId: string,
): Promise<void> {
  try {
    await transactWrite(
      [
        {
          Delete: {
            Key: childPointer(parentActivityId, childActivityId),
            ConditionExpression: 'attribute_exists(pk)',
          },
        },
        childCountDelta(parentActivityId, -1),
      ],
      { operation: 'detachChildFromParent' },
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'conflict') throw error;
  }
}

/** One resolved source row: where it sits now, and the id that must still be there. */
export interface IngredientAddition {
  readonly index: number;
  readonly ingredientId: string;
}

/**
 * The transact item that records these ingredients as added, for a caller composing one
 * transaction (P3-17).
 *
 * ## Located by id, written by index, guarded by both
 *
 * DynamoDB addresses a list element by position — `details.ingredients[3].addedToListId` —
 * and position is the one thing about an ingredient array that is not stable. So the caller
 * resolves each `ingredientId` to its **current** index and hands both over, and every index
 * carries its own condition that the id still sitting there is the id that was resolved. A
 * reorder between the read and the commit fails the condition and cancels the whole
 * transaction rather than marking a neighbour.
 *
 * ## It advances `updatedAt`, and that was a correction
 *
 * The first version deliberately did not, treating provenance as bookkeeping about a
 * different object. Review pushed back and was right for a reason the original argument
 * missed: `addedToListId` is **rendered** — it is
 * what makes a meal's ingredient row say `Added` — and it lives inside `details`, which
 * `PATCH` replaces wholesale under `If-Match`. A field that changes what the user sees, on a
 * versioned object, has to move the version, or a client holding the pre-write copy both
 * renders staleness and passes the concurrency check.
 *
 * `expectedUpdatedAt` is therefore also a **condition**: the caller read this Activity to
 * resolve the ids, and a patch landing in between must lose here rather than silently having
 * its ingredient array overwritten by indexes resolved against the old one.
 */
export function ingredientsAddedToListItem(
  activityId: string,
  listId: string,
  additions: readonly IngredientAddition[],
  expectedUpdatedAt: string,
  now: string,
): TransactItem {
  const names: Record<string, string> = {
    '#details': 'details',
    '#ingredients': 'ingredients',
    '#addedToListId': 'addedToListId',
    '#ingredientId': 'ingredientId',
    '#updatedAt': 'updatedAt',
  };
  const values: Record<string, unknown> = {
    ':listId': listId,
    ':updatedAt': now,
    ':expectedUpdatedAt': expectedUpdatedAt,
  };
  const sets: string[] = ['#updatedAt = :updatedAt'];
  const conditions: string[] = [
    'attribute_exists(pk)',
    '#updatedAt = :expectedUpdatedAt',
  ];

  for (const addition of additions) {
    const at = String(addition.index);
    values[`:id${at}`] = addition.ingredientId;
    sets.push(`#details.#ingredients[${at}].#addedToListId = :listId`);
    conditions.push(`#details.#ingredients[${at}].#ingredientId = :id${at}`);
  }

  return {
    Update: {
      Key: activityMeta(activityId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ConditionExpression: conditions.join(' AND '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/**
 * Removes one List back-pointer and advances the Activity version.
 *
 * `listId` / `listItemId` are part of the versioned Activity even though projection is
 * access-filtered. Removing them without moving `updatedAt` lets a client holding the old
 * version pass its next `If-Match`; the cleanup and every transactional item-delete path
 * therefore advance the same concurrency token.
 *
 * The provenance condition keeps the list-delete cascade idempotent: a missing, deleted or
 * repointed Activity is skipped, never clobbered.
 */
export async function clearListProvenance(
  activityId: string,
  listId: string,
  updatedAt: string,
): Promise<void> {
  try {
    await updateItem(activityMeta(activityId), {
      expression: 'SET #updatedAt = :updatedAt REMOVE #listId, #listItemId',
      names: {
        '#updatedAt': 'updatedAt',
        '#listId': 'listId',
        '#listItemId': 'listItemId',
      },
      values: { ':listId': listId, ':updatedAt': updatedAt },
      condition: 'attribute_exists(pk) AND #listId = :listId',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
}
