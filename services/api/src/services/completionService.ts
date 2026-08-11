import {
  type ActivityCompletionResult,
  activity as activitySchema,
  type CompleteActivityInput,
  type SkipActivityInput,
  type UncompleteActivityInput,
} from '@od/shared/schemas';
import type { Activity, ActivityOutcome, Occurrence } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import {
  getActivityMeta,
  listParticipants,
  patchActivity,
} from '../repositories/activityRepository.js';
import { receiptItem } from '../repositories/idempotencyRepository.js';
import type { StoredItem } from '../repositories/migrate.js';
import * as occurrenceRepository from '../repositories/occurrenceRepository.js';
import { TransactionBuilder, transactWrite } from '../repositories/tx.js';
import { deriveActionCapabilities } from './actionCapabilities.js';

const NOT_FOUND = 'Activity not found.';
const OWNER_ONLY = 'Only the person who created this can change it.';
const OUTCOME_MISMATCH = 'That outcome does not match this activity type.';
const OCCURRENCE_NEEDS_SERIES = 'occurrenceDate requires a recurring activity.';

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
  const result: ActivityCompletionResult = { activity: next, outcome };

  await patchActivity(userId, next, activity.updatedAt, {
    previous: activity,
    indexedUserIds: context.indexedUserIds,
    ...(context.parent === undefined ? {} : { taskSubtitle: context.parent.title }),
    ...(activity.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    idempotencyReceipt: receiptFor(result),
  });
  return result;
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
  await patchActivity(userId, next, activity.updatedAt, {
    previous: activity,
    indexedUserIds: context.indexedUserIds,
    ...(context.parent === undefined ? {} : { taskSubtitle: context.parent.title }),
    ...(activity.parentActivityId === undefined ? {} : { updateChildPointer: true }),
    idempotencyReceipt: receiptFor(result),
  });
  return result;
}

/** Hydrate relationships first; the policy verdict remains pure and reusable. */
async function resolveActionContext(
  userId: string,
  activityId: string,
  action: 'complete' | 'skip' = 'complete',
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
