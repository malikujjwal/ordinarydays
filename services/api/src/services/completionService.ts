import { toUtcInstant } from '@od/shared/recurrence';
import {
  type ActivityCompletionResult,
  activity as activitySchema,
  type CompleteActivityInput,
  type CompletionFollowUp,
  type SkipActivityInput,
  type SnoozeActivityInput,
  type UncompleteActivityInput,
  type UnsnoozeActivityInput,
} from '@od/shared/schemas';
import {
  type Activity,
  type ActivityDetails,
  type ActivityOutcome,
  type ActivitySchedule,
  type ActivityScope,
  activityScope,
  type List,
  type ListItem,
  type ListItemActivityLink,
  type ListItemDetails,
  type Occurrence,
  scopeFromWire,
  targetsWholeSeries,
} from '@od/shared/types';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { logger } from '../lib/logger.js';
import {
  getActivityMeta,
  listParticipants,
  patchActivity,
  putActivityMeta,
  StaleViewerLinkError,
} from '../repositories/activityRepository.js';
import { receiptItem } from '../repositories/idempotencyRepository.js';
import {
  findViewerLinksTo,
  readWatchFollowUpSource,
} from '../repositories/listRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import * as occurrenceRepository from '../repositories/occurrenceRepository.js';
import { TransactionBuilder, transactWrite } from '../repositories/tx.js';
import { deriveActionCapabilities } from './actionCapabilities.js';
import { assertListAccess } from './authz.js';
import { hasUpdatesFeed, writeSystemUpdate } from './updatesService.js';

const NOT_FOUND = 'Activity not found.';
const OWNER_ONLY = 'Only the person who created this can change it.';
const OUTCOME_MISMATCH = 'That outcome does not match this activity type.';
const OCCURRENCE_NEEDS_SERIES = 'occurrenceDate requires a recurring activity.';
const SERIES_NEEDS_OCCURRENCE = 'occurrenceDate is required for a recurring activity.';
const TIMED_ONLY = 'Only a timed activity can be snoozed.';
const SNOOZE_PAST = 'Snooze time must not be earlier than the current time.';
const SNOOZE_RANGE = 'A snoozed occurrence must stay within 60 calendar days.';
const ONE_OFF_SAME_DAY = 'Use schedule to move a one-off activity to another day.';
const WALL_DATE = 'yyyy-MM-dd';

type ReceiptFor = (data: unknown) => IdempotencyReceipt;

interface ActionContext {
  readonly activity: Activity;
  readonly parent?: Activity;
  readonly indexedUserIds: readonly string[];
}

/** Complete an Activity META row, or exactly one occurrence override for a series. */
export async function completeActivity(
  userId: string,
  activityId: string,
  input: CompleteActivityInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ActivityCompletionResult> {
  const context = await resolveActionContext(userId, activityId);
  const { activity } = context;
  const outcome = resolveOutcome(activity, input.outcome);

  if (input.occurrenceDate !== undefined) {
    assertRecurring(activity);
    const status = isNegative(outcome) ? 'skipped' : 'completed';
    const existing = await occurrenceRepository.get(activityId, input.occurrenceDate);
    if (existing?.status === 'completed' || existing?.status === 'skipped') {
      const existingOutcome =
        existing.status === 'skipped'
          ? negativeOutcome(activity)
          : resolveOutcome(activity);
      const result: ActivityCompletionResult = {
        activity,
        occurrenceDate: input.occurrenceDate,
        occurrence: existing,
        outcome: existingOutcome,
      };
      await commitReceipt(receiptFor(result), 'completeActivityOccurrence');
      return result;
    }

    const occurrence: Occurrence = {
      activityId,
      date: input.occurrenceDate,
      status,
      ...(status === 'completed' ? { completedAt: now } : {}),
    };
    const result: ActivityCompletionResult = {
      activity,
      occurrenceDate: input.occurrenceDate,
      occurrence,
      outcome,
    };
    const receipt = receiptFor(result);
    const tx = new TransactionBuilder('completeActivityOccurrence', 1);
    await occurrenceRepository.put(occurrence, tx);
    await commit(tx, receipt);
    return result;
  }

  assertOccurrenceScoped(activity, scopeFromWire(input));

  if (
    activity.status === 'cancelled' ||
    activity.status === 'completed' ||
    activity.status === 'skipped'
  ) {
    const result: ActivityCompletionResult = {
      activity,
      ...(activity.outcome === undefined ? {} : { outcome: activity.outcome }),
    };
    await commitReceipt(receiptFor(result), 'completeActivity');
    return result;
  }

  const status = isNegative(outcome) ? 'skipped' : 'completed';
  const next = withoutCompletionFields({
    ...activity,
    status,
    updatedAt: now,
  });
  next.outcome = outcome;
  if (status === 'completed') next.completedAt = now;
  /**
   * Computed **before** the write, because `receiptFor` freezes the response body below and a
   * replay must return the same one. A negative outcome produced `skipped` above and gets
   * nothing: it cleared the pointer this would have read, and a session that did not happen
   * is not evidence about anything.
   */
  const followUp = status === 'completed' ? await watchFollowUp(userId, next) : undefined;
  const result: ActivityCompletionResult = {
    activity: next,
    outcome,
    ...(followUp === undefined ? {} : { followUp }),
  };

  /**
   * **One system entry, on completion only** (§P3-19, `plans-and-lists.md` §9.3 step 10).
   *
   * Completion is the event a feed reader cares about; a *skip* is the absence of one, and a
   * negative outcome already tells its own story through the activity's status. In the same
   * transaction as the status write, so the feed cannot claim a completion that did not
   * commit — or miss one that did.
   *
   * A **Task** gets none either: the feed is the plan's, and Task detail has no section that
   * could ever show one.
   *
   * Recurring occurrences never reach here: they take the `occurrenceDate` path above, which
   * writes an occurrence-override row and never the series. One occurrence being done is not
   * the plan being done, and a feed entry saying otherwise would be a lie about a series that
   * is still running.
   */
  const systemEntry =
    status === 'completed' && hasUpdatesFeed(next)
      ? writeSystemUpdate(activityId, completionEntryBody(next), now)
      : undefined;

  await writeStatusClearingLinks(userId, next, activity.updatedAt, {
    previous: activity,
    indexedUserIds: context.indexedUserIds,
    ...(context.parent === undefined ? {} : { taskSubtitle: context.parent.title }),
    ...(activity.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    ...(systemEntry === undefined ? {} : { extraItems: [systemEntry] }),
    idempotencyReceipt: receiptFor(result),
  });
  return result;
}

/**
 * The completion entry's copy, in the type's own vocabulary.
 *
 * `activities.md` §5.2 already owns the verb a user taps — Watched, Had it, Attended — so the
 * feed reuses that rather than inventing a second vocabulary for the same event. Copy settled
 * here and named in the PR, since §2.1 row 9 specifies that these rows exist and not what they
 * say.
 */
function completionEntryBody(activity: Activity): string {
  switch (activity.outcome) {
    case 'watched':
      return 'Marked watched.';
    case 'had_it':
      return 'Marked as had.';
    case 'attended':
      return 'Marked attended.';
    default:
      return 'Marked complete.';
  }
}

/** Reverse completed/skipped state, or delete one occurrence override. */
export async function uncompleteActivity(
  userId: string,
  activityId: string,
  input: UncompleteActivityInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ActivityCompletionResult> {
  const context = await resolveActionContext(userId, activityId);
  const { activity } = context;

  if (input.occurrenceDate !== undefined) {
    assertRecurring(activity);
    const existing = await occurrenceRepository.get(activityId, input.occurrenceDate);
    const baseResult: ActivityCompletionResult = {
      activity,
      occurrenceDate: input.occurrenceDate,
    };
    if (existing?.status !== 'completed' && existing?.status !== 'skipped') {
      const result: ActivityCompletionResult = {
        ...baseResult,
        ...(existing === null ? {} : { occurrence: existing }),
      };
      await commitReceipt(receiptFor(result), 'uncompleteActivityOccurrence');
      return result;
    }
    const receipt = receiptFor(baseResult);
    const tx = new TransactionBuilder('uncompleteActivityOccurrence', 1);
    await occurrenceRepository.delete(activityId, input.occurrenceDate, tx);
    await commit(tx, receipt);
    return baseResult;
  }

  if (activity.status !== 'completed' && activity.status !== 'skipped') {
    const result: ActivityCompletionResult = { activity };
    await commitReceipt(receiptFor(result), 'uncompleteActivity');
    return result;
  }

  const next = withoutCompletionFields({
    ...activity,
    status: activity.schedule === undefined ? 'saved' : 'scheduled',
    updatedAt: now,
  });
  const result: ActivityCompletionResult = { activity: next };
  await patchActivity(userId, next, activity.updatedAt, {
    previous: activity,
    indexedUserIds: context.indexedUserIds,
    ...(context.parent === undefined ? {} : { taskSubtitle: context.parent.title }),
    ...(activity.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    idempotencyReceipt: receiptFor(result),
  });
  return result;
}

/** Skip an Activity META row, or exactly one occurrence override for a series. */
export async function skipActivity(
  userId: string,
  activityId: string,
  input: SkipActivityInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ActivityCompletionResult> {
  const context = await resolveActionContext(userId, activityId, 'skip');
  const { activity } = context;

  if (input.occurrenceDate !== undefined) {
    assertRecurring(activity);
    const existing = await occurrenceRepository.get(activityId, input.occurrenceDate);
    if (existing?.status === 'skipped') {
      const result: ActivityCompletionResult = {
        activity,
        occurrenceDate: input.occurrenceDate,
        occurrence: existing,
      };
      await commitReceipt(receiptFor(result), 'skipActivityOccurrence');
      return result;
    }

    const occurrence: Occurrence = {
      activityId,
      date: input.occurrenceDate,
      status: 'skipped',
    };
    const result: ActivityCompletionResult = {
      activity,
      occurrenceDate: input.occurrenceDate,
      occurrence,
    };
    const tx = new TransactionBuilder('skipActivityOccurrence', 1);
    await occurrenceRepository.put(occurrence, tx);
    await commit(tx, receiptFor(result));
    return result;
  }

  assertOccurrenceScoped(activity, scopeFromWire(input));

  if (activity.status === 'cancelled' || activity.status === 'skipped') {
    const result: ActivityCompletionResult = { activity };
    await commitReceipt(receiptFor(result), 'skipActivity');
    return result;
  }

  const next = withoutCompletionFields({
    ...activity,
    status: 'skipped',
    updatedAt: now,
  });
  const result: ActivityCompletionResult = { activity: next };
  await writeStatusClearingLinks(userId, next, activity.updatedAt, {
    previous: activity,
    indexedUserIds: context.indexedUserIds,
    ...(context.parent === undefined ? {} : { taskSubtitle: context.parent.title }),
    ...(activity.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    idempotencyReceipt: receiptFor(result),
  });
  return result;
}

type WatchProgress = Extract<ListItemDetails, { behaviour: 'watch' }>;
type WatchSession = Extract<ActivityDetails, { kind: 'watch' }>;

/**
 * The one contextual follow-up a completed watch session may offer (P3-16).
 *
 * ## It reads. It never writes.
 *
 * Everything below produces a value the response carries and the client renders. Confirming
 * is a separate user action: an ordinary `PATCH /v1/lists/:id/items/:itemId` the client
 * issues, through the route that already enforces the behaviour and field gates. There is no
 * confirm endpoint, and a write reachable from here would be exactly the auto-create
 * `CLAUDE.md` rule 5 and `agent-playbook.md` §6.9 forbid — the tell being a mutation inside
 * a handler for a different operation.
 *
 * ## The five things that must all hold
 *
 * A `watch` Activity; both halves of its list provenance; the caller's **own** pointer
 * resolving to **this** Activity; a list still on `behaviour: 'watch'`; and an item that
 * still exists with typed watch `details`. A miss on any one of them is silence, not an
 * error — the caller completed something, and there is nothing to tell them about it.
 *
 * The pointer identity is the one worth spelling out. `listItemId` on the Activity says which
 * item this Plan came from; the viewer-link row says which Plan this viewer currently has for
 * that item. They disagree once the viewer plans the same item again, and it is the **pointer**
 * that decides, because it is the pointer the item's own state line renders from
 * (`ADR-034`). Completing last week's superseded session must not offer to advance progress
 * on behalf of the session that replaced it. And reading the caller's key directly means
 * another member's private Plan for the same item is never loaded, let alone described
 * (`security-privacy.md` row 15a).
 *
 * ## Nothing here can fail the completion
 *
 * The user completed their Plan; a suggestion about a list is not worth losing that to. Every
 * failure — no list pointer for this caller, a list mid-migration answering the retryable
 * fence error, a row that will not parse — becomes no follow-up, logged with ids only. It is
 * awaited rather than left floating so a rejection cannot surface in an unrelated request
 * (`coding-standards.md` §6.1).
 *
 * There is no recurrence check here because there cannot be one to make: an occurrence
 * completion returned long before this point with its occurrence override, and an unscoped
 * recurring completion was rejected by `assertOccurrenceScoped`. Both leave series META
 * untouched, which is the whole of `CLAUDE.md` rule 3 and the reason a recurring occurrence
 * offers nothing (`activities.md` §5.3, last row).
 */
async function watchFollowUp(
  userId: string,
  activity: Activity,
): Promise<CompletionFollowUp | undefined> {
  // `details.kind` and `type` are equal by schema refinement, so this is the `watch` check
  // and the narrowing `suggestionFor` needs, in one line rather than a check plus a cast.
  if (activity.details.kind !== 'watch') return undefined;
  const { listId, listItemId } = activity;
  if (listId === undefined || listItemId === undefined) return undefined;

  try {
    const access = await assertListAccess(userId, listId, 'read');
    const source = await readWatchFollowUpSource(
      userId,
      listId,
      access.index,
      listItemId,
    );
    if (source === undefined) return undefined;
    if (source.link.activityId !== activity.activityId) return undefined;
    const progress = source.item.details;
    if (progress?.behaviour !== 'watch') return undefined;
    return suggestionFor(source.list, source.item, progress, activity.details);
  } catch (error) {
    logger.info(
      { userId, activityId: activity.activityId, listId, listItemId, err: error },
      'No completion follow-up: the linked list item could not be read.',
    );
    return undefined;
  }
}

/**
 * Which of `activities.md` §5.3's two watch rows this is, and what it would set.
 *
 * Pure, and the only place the choice is made. `mediaKind` selects: a movie's follow-up is
 * the `watched` transition and a movie has no episode to advance to, while everything else
 * offers the session's own season and episode. Each arm carries the `mediaKind` that chose
 * it, so the schema refuses a row whose kind and media disagree rather than trusting this
 * function to be the only producer.
 *
 * **An item with no `mediaKind` takes the progress branch, and is not guessed at.** P3-09's
 * back-fill writes `watchStatus: 'want'` and nothing else, so a `collection` upgraded to
 * `watch` has a whole list of them, and refusing those items a follow-up would quietly make
 * the feature depend on how the list was created. What the progress branch offers is not an
 * opinion about the media: it is the season and episode **the user typed on this session**,
 * copied onto the item they said it came from. When the session names neither there is
 * nothing to copy and nothing is offered — `Update to ?` is not a question, and `watched` is
 * not an answer the app is allowed to reach for on a show, whose ending it cannot know
 * (`plans-and-lists.md` §8.1).
 *
 * A target equal to the item's current values is left alone rather than suppressed. That is a
 * **rewatch**, which §8.4 names as an ordinary case the user answers by dismissing; deciding
 * the question is not worth asking would be the server having an opinion about what the
 * session meant.
 */
function suggestionFor(
  list: List,
  item: ListItem,
  progress: WatchProgress,
  session: WatchSession,
): CompletionFollowUp | undefined {
  const shared = {
    listId: list.listId,
    listTitle: list.title,
    itemId: item.itemId,
    current: {
      watchStatus: progress.watchStatus,
      ...(progress.season === undefined ? {} : { season: progress.season }),
      ...(progress.episode === undefined ? {} : { episode: progress.episode }),
    },
  };

  const mediaKind = progress.mediaKind;
  if (mediaKind === 'movie') {
    return {
      kind: 'watch_watched',
      ...shared,
      mediaKind,
      target: { watchStatus: 'watched' },
    };
  }

  /**
   * Two returns rather than one built by spreading, because the target is a union of
   * "season, optionally with an episode" and "episode alone" — and writing it as two
   * optionals spread together is exactly how the empty target became expressible. Each
   * branch here produces one arm of that union, and neither can produce nothing.
   */
  const named = {
    kind: 'watch_progress',
    ...shared,
    ...(mediaKind === undefined ? {} : { mediaKind }),
  } as const;
  const { season, episode } = session;
  if (season !== undefined) {
    return {
      ...named,
      target: { season, ...(episode === undefined ? {} : { episode }) },
    };
  }
  if (episode !== undefined) return { ...named, target: { episode } };
  return undefined;
}

/**
 * The viewer pointers a status transition clears — keyed on the **resulting status**, never
 * on which endpoint was called (P3-15).
 *
 * That distinction is the whole reason this is one function. A negative outcome —
 * `didnt_happen`, or `didnt_go` on an event — arrives through `POST /complete` and produces
 * `status: 'skipped'`. Keying on the endpoint would clear pointers for `/skip` and silently
 * leave them for the identical transition through `/complete`, so one user action would
 * behave two ways depending on which route the client happened to use.
 *
 * The lifecycle table clears pointers on **skipped** alone. Complete and reschedule keep
 * them, and `undefined` is what says so — nothing to clear is the absence of pointer work,
 * not an empty list of it.
 *
 * **Uncomplete does not call this, and deliberately does not restore.** No row in the table
 * restores a cleared pointer: un-completing reverses the status, and the pointer that a skip
 * removed is not part of that status. Re-linking is `Plan this item` again, which is an
 * explicit action with its own confirmation.
 *
 * Only a non-occurrence transition reaches here. An occurrence-only skip writes its own
 * occurrence override and returns long before, leaving the series and its pointer untouched
 * (`agent-playbook.md` §6.7).
 */
async function viewerLinksClearedBy(
  next: Activity,
): Promise<{ clearViewerLinks?: ListItemActivityLink[] }> {
  if (next.status !== 'skipped') return {};
  if (next.listId === undefined || next.listItemId === undefined) return {};
  return {
    clearViewerLinks: await findViewerLinksTo(
      next.listId,
      next.listItemId,
      next.activityId,
    ),
  };
}

/**
 * How many times a status write will re-read its pointers and try again.
 *
 * Each attempt loses only to a pointer that changed **since the read**, and a viewer replaces
 * their own pointer by making a Plan — a deliberate act, not a loop. Two retries is generous
 * for that, and bounded so a pathological contender cannot spin.
 */
const VIEWER_LINK_ATTEMPTS = 3;

/**
 * Writes the status, clearing pointers, and does not let a moved pointer cancel the status.
 *
 * The pointer deletes are conditional so a viewer who has just planned the item again keeps
 * their newer pointer — and being in the same transaction as the status write is what makes
 * skipping one user-visible event. Those two are in tension: a failing condition cancels the
 * **whole** transaction, so without this the user's skip would silently not happen because an
 * unrelated pointer moved, surfacing as a retryable `503` with the Plan still un-skipped.
 *
 * So a pointer-condition failure is not an error here. It is a signal that the set was read
 * too early: re-read it, and try again. The next attempt no longer names the replaced pointer,
 * so the skip commits and the newer Plan's pointer is untouched — which is exactly what both
 * rules asked for.
 */
async function writeStatusClearingLinks(
  userId: string,
  next: Activity,
  expectedUpdatedAt: string,
  options: Omit<Parameters<typeof patchActivity>[3], 'clearViewerLinks'>,
): Promise<void> {
  for (let attempt = 0; attempt < VIEWER_LINK_ATTEMPTS; attempt += 1) {
    try {
      await patchActivity(userId, next, expectedUpdatedAt, {
        ...options,
        ...(await viewerLinksClearedBy(next)),
      });
      return;
    } catch (error) {
      if (!(error instanceof StaleViewerLinkError)) throw error;
    }
  }
  /**
   * Three reads in a row each raced. The status has **not** been written, and saying so is
   * the honest answer — a retryable conflict the client repeats, rather than a success the
   * user's Plan does not reflect.
   */
  throw new AppError('conflict', 'This changed while you were editing it. Try again.');
}

/** Snooze a one-off META row or exactly one recurring occurrence. */
export async function snoozeActivity(
  userId: string,
  activityId: string,
  input: SnoozeActivityInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ActivityCompletionResult> {
  const context = await resolveActionContext(userId, activityId, 'snooze');
  const { activity } = context;
  const schedule = timedSchedule(activity);
  const occurrenceDate = resolveSnoozeTarget(activity, input.occurrenceDate);
  const destinationDate = validateSnoozeUntil(
    activity,
    occurrenceDate ?? schedule.date,
    input.until,
    now,
  );

  if (occurrenceDate === undefined) {
    if (destinationDate !== schedule.date) validation('until', ONE_OFF_SAME_DAY);
    const next: Activity = { ...activity, snoozedUntil: input.until, updatedAt: now };
    const result: ActivityCompletionResult = { activity: next };
    const tx = new TransactionBuilder('snoozeActivity', 1);
    putActivityMeta(next, activity.updatedAt, tx);
    await commit(tx, receiptFor(result));
    return result;
  }

  const existing = await occurrenceRepository.get(activityId, occurrenceDate);
  const occurrence: Occurrence = {
    activityId,
    date: occurrenceDate,
    status: 'snoozed',
    snoozedUntil: input.until,
  };
  const result: ActivityCompletionResult = { activity, occurrenceDate, occurrence };
  const tx = new TransactionBuilder('snoozeActivityOccurrence', 1);
  await occurrenceRepository.put(occurrence, tx);
  await appendMarkerChanges(
    activity,
    occurrenceDate,
    markerDestination(activity, occurrenceDate, existing?.snoozedUntil),
    destinationDate === occurrenceDate ? undefined : destinationDate,
    now,
    tx,
  );
  await commit(tx, receiptFor(result));
  return result;
}

/** Remove only snooze state; completion, skip and reschedule overrides survive. */
export async function unsnoozeActivity(
  userId: string,
  activityId: string,
  input: UnsnoozeActivityInput,
  now: string,
  receiptFor: ReceiptFor,
): Promise<ActivityCompletionResult> {
  const { activity } = await resolveActionContext(userId, activityId, 'snooze');
  const occurrenceDate = resolveSnoozeTarget(activity, input.occurrenceDate);

  if (occurrenceDate === undefined) {
    if (activity.snoozedUntil === undefined) {
      const result: ActivityCompletionResult = { activity };
      await commitReceipt(receiptFor(result), 'unsnoozeActivity');
      return result;
    }
    const next: Activity = { ...activity, updatedAt: now };
    delete next.snoozedUntil;
    const result: ActivityCompletionResult = { activity: next };
    const tx = new TransactionBuilder('unsnoozeActivity', 1);
    putActivityMeta(next, activity.updatedAt, tx);
    await commit(tx, receiptFor(result));
    return result;
  }

  const existing = await occurrenceRepository.get(activityId, occurrenceDate);
  const baseResult: ActivityCompletionResult = { activity, occurrenceDate };
  if (existing?.status !== 'snoozed') {
    const result: ActivityCompletionResult = {
      ...baseResult,
      ...(existing === null ? {} : { occurrence: existing }),
    };
    await commitReceipt(receiptFor(result), 'unsnoozeActivityOccurrence');
    return result;
  }

  const tx = new TransactionBuilder('unsnoozeActivityOccurrence', 1);
  await occurrenceRepository.delete(activityId, occurrenceDate, tx);
  await appendMarkerChanges(
    activity,
    occurrenceDate,
    markerDestination(activity, occurrenceDate, existing.snoozedUntil),
    undefined,
    now,
    tx,
  );
  await commit(tx, receiptFor(baseResult));
  return baseResult;
}

/** Hydrate relationships first; the policy verdict remains pure and reusable. */
async function resolveActionContext(
  userId: string,
  activityId: string,
  action: 'complete' | 'skip' | 'snooze' = 'complete',
): Promise<ActionContext> {
  const storedActivity = await getActivityMeta(activityId);
  if (storedActivity === undefined) throw new AppError('not_found', NOT_FOUND);
  const activity = activitySchema.parse(storedActivity) as Activity;

  const directParticipants = await listParticipants(activityId);
  const isDirectParticipant = hasUser(directParticipants, userId);
  const storedParent =
    activity.parentActivityId === undefined
      ? undefined
      : await getActivityMeta(activity.parentActivityId);
  const parent =
    storedParent === undefined
      ? undefined
      : (activitySchema.parse(storedParent) as Activity);
  const parentParticipants =
    parent === undefined || parent.ownerId === userId
      ? []
      : await listParticipants(parent.activityId);
  const participatesInParent = hasUser(parentParticipants, userId);
  const callerRole =
    activity.ownerId === userId ? 'owner' : isDirectParticipant ? 'participant' : 'none';
  const related =
    callerRole !== 'none' || parent?.ownerId === userId || participatesInParent;
  if (!related) throw new AppError('not_found', NOT_FOUND);

  const capability = deriveActionCapabilities({
    activity,
    callerId: userId,
    callerRole,
    ...(parent === undefined ? {} : { parentOwnerId: parent.ownerId }),
    participatesInParent,
  });
  if (!capability[action]) throw new AppError('forbidden', OWNER_ONLY);

  const indexedUserIds = [
    ...new Set([
      activity.ownerId,
      ...directParticipants.flatMap((row) =>
        typeof row.userId === 'string' ? [row.userId] : [],
      ),
    ]),
  ];
  return { activity, ...(parent === undefined ? {} : { parent }), indexedUserIds };
}

function resolveSnoozeTarget(
  activity: Activity,
  requested: string | undefined,
): string | undefined {
  timedSchedule(activity);
  if (requested !== undefined) {
    assertRecurring(activity);
    return requested;
  }
  if (activity.recurrence !== undefined)
    validation('occurrenceDate', SERIES_NEEDS_OCCURRENCE);
  return undefined;
}

function validateSnoozeUntil(
  activity: Activity,
  occurrenceDate: string,
  until: string,
  now: string,
): string {
  const timezone = timedSchedule(activity).timezone;
  const instant = until.includes('T')
    ? until
    : toUtcInstant(occurrenceDate, until, timezone);
  if (Date.parse(instant) < Date.parse(now)) validation('until', SNOOZE_PAST);
  const destinationDate = until.includes('T')
    ? formatInTimeZone(new Date(until), timezone, WALL_DATE)
    : occurrenceDate;
  const distance = Math.abs(
    differenceInCalendarDays(parseISO(destinationDate), parseISO(occurrenceDate)),
  );
  if (distance > 60) validation('until', SNOOZE_RANGE);
  return destinationDate;
}

function markerDestination(
  activity: Activity,
  occurrenceDate: string,
  until: string | undefined,
): string | undefined {
  if (until?.includes('T') !== true) return undefined;
  const destination = formatInTimeZone(
    new Date(until),
    timedSchedule(activity).timezone,
    WALL_DATE,
  );
  return destination === occurrenceDate ? undefined : destination;
}

async function appendMarkerChanges(
  activity: Activity,
  occurrenceDate: string,
  oldDestination: string | undefined,
  newDestination: string | undefined,
  now: string,
  tx: TransactionBuilder,
): Promise<void> {
  const destinations = [...new Set([oldDestination, newDestination].filter(isString))];
  const markers = await Promise.all(
    destinations.map((date) =>
      occurrenceRepository.getMoveMarker(activity.activityId, date),
    ),
  );

  destinations.forEach((destination, index) => {
    const previous = markers[index] ?? null;
    const movedFrom = new Set(previous?.movedFrom ?? []);
    if (destination === oldDestination) movedFrom.delete(occurrenceDate);
    if (destination === newDestination) movedFrom.add(occurrenceDate);
    const next = [...movedFrom].sort();
    if (previous === null && next.length === 0) return;
    if (next.length === 0) {
      if (previous !== null) occurrenceRepository.deleteMoveMarker(previous, tx);
      return;
    }
    if (
      previous !== null &&
      previous.movedFrom.length === next.length &&
      previous.movedFrom.every((value, itemIndex) => value === next[itemIndex])
    ) {
      return;
    }
    occurrenceRepository.putMoveMarker(
      { activityId: activity.activityId, destinationDate: destination, movedFrom: next },
      previous,
      now,
      tx,
    );
  });
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}

function timedSchedule(activity: Activity): ActivitySchedule & { time: string } {
  const schedule = activity.schedule;
  if (schedule === undefined) validation('until', TIMED_ONLY);
  const time = schedule.time;
  if (time === undefined) validation('until', TIMED_ONLY);
  return { ...schedule, time };
}

function validation(path: string, message: string): never {
  throw new AppError('validation_failed', message, [{ path, message }]);
}

function hasUser(rows: readonly StoredItem[], userId: string): boolean {
  return rows.some((row) => typeof row.userId === 'string' && row.userId === userId);
}

function resolveOutcome(
  activity: Activity,
  requested?: ActivityOutcome,
): ActivityOutcome {
  const allowed: Record<Activity['type'], readonly ActivityOutcome[]> = {
    task: ['done', 'didnt_happen'],
    meal: ['had_it', 'didnt_happen'],
    watch: ['watched', 'didnt_happen'],
    event: ['attended', 'didnt_go'],
    custom: ['done', 'didnt_happen'],
  };
  const defaults: Record<Activity['type'], ActivityOutcome> = {
    task: 'done',
    meal: 'had_it',
    watch: 'watched',
    event: 'attended',
    custom: 'done',
  };
  const outcome = requested ?? defaults[activity.type];
  if (!allowed[activity.type].includes(outcome)) {
    throw new AppError('validation_failed', OUTCOME_MISMATCH, [
      { path: 'outcome', message: OUTCOME_MISMATCH },
    ]);
  }
  return outcome;
}

function isNegative(outcome: ActivityOutcome): boolean {
  return outcome === 'didnt_happen' || outcome === 'didnt_go';
}

function negativeOutcome(activity: Activity): ActivityOutcome {
  return activity.type === 'event' ? 'didnt_go' : 'didnt_happen';
}

function assertRecurring(activity: Activity): void {
  if (activity.recurrence !== undefined) return;
  throw new AppError('validation_failed', OCCURRENCE_NEEDS_SERIES, [
    { path: 'occurrenceDate', message: OCCURRENCE_NEEDS_SERIES },
  ]);
}

/**
 * The inverse of `assertRecurring`: a series may not be completed or skipped as a whole.
 *
 * **Why this had to exist.** Without an `occurrenceDate` both paths fell through to
 * `patchActivity` and set `status: 'completed'` on the series META itself. That alone would be a
 * quiet mistake; `agendaService`'s `mergeNominal` makes it loud, because an occurrence with no
 * override renders with `entry.activity.status` — so one unscoped write crossed off **every**
 * future occurrence of the series. Reported as "select complete on today's occurrence and it
 * marks the future ones complete".
 *
 * `snooze` has refused this since it was written (`resolveSnoozeTarget`); `complete` and `skip`
 * simply never grew the same guard, and CLAUDE.md rule 3 covers all three equally: an
 * occurrence action writes an `Occurrence` override and must never mutate the series.
 *
 * **Uncomplete is deliberately not guarded.** An unscoped uncomplete is what clears a series
 * status this bug already set, and is the only route back for an activity in that state.
 */
function assertOccurrenceScoped(
  activity: Activity,
  scope: ActivityScope = activityScope(),
): void {
  if (!targetsWholeSeries(activity.recurrence !== undefined, scope)) return;
  throw new AppError('validation_failed', SERIES_NEEDS_OCCURRENCE, [
    { path: 'occurrenceDate', message: SERIES_NEEDS_OCCURRENCE },
  ]);
}

function withoutCompletionFields(activity: Activity): Activity {
  const next = { ...activity };
  delete next.completedAt;
  delete next.outcome;
  return next;
}

async function commitReceipt(
  receipt: IdempotencyReceipt,
  operation: string,
): Promise<void> {
  await commit(new TransactionBuilder(operation, 1), receipt);
}

async function commit(
  tx: TransactionBuilder,
  receipt: IdempotencyReceipt,
): Promise<void> {
  const receiptIndex = tx.length;
  tx.addReserved(receiptItem(receipt));
  await transactWrite(tx.build(), {
    operation: tx.operation,
    onConditionFailed: (index) =>
      index === receiptIndex ? new IdempotencyRaceError() : undefined,
  });
}
