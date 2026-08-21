import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type { ActivityOutcome } from '@od/shared/types';
import { changesRecurrenceTopology } from '@/lib/mutationKeys';
import type {
  ActivityCompletionVariables,
  ActivityCreateVariables,
  ActivityPatchVariables,
  ActivityReminderDeleteVariables,
  ActivityReminderVariables,
  ActivityScheduleVariables,
  ActivitySnoozeVariables,
  ActivityTransactionService,
  ProjectionClock,
  TransactionalIntentResult,
} from '@/lib/sqlite/activityTransactions';
import { recordNativePerformanceMetric } from '@/lib/sqlite/nativePerformance';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { NativeSyncEngine } from '@/lib/sqlite/syncEngine';
import type {
  SerializedTransactionRunner,
  TransactionContext,
} from '@/lib/sqlite/transaction';

export type NativeActionResult =
  | {
      readonly kind: 'accepted';
      readonly status: 'queued';
      readonly intent: OutboxIntent;
      readonly commitRevision: number;
    }
  | { readonly kind: 'cancelled'; readonly commitRevision: number }
  | { readonly kind: 'refused'; readonly error: Error };

export class NativeActivityActionCoordinator {
  private readonly completionCommits = new Map<
    string,
    { readonly completed: boolean; readonly promise: Promise<NativeActionResult> }
  >();

  constructor(
    readonly ownerUserId: string,
    private readonly transactions: SerializedTransactionRunner,
    private readonly service: ActivityTransactionService,
    private readonly outbox: OutboxRepository,
    private readonly sync: NativeSyncEngine,
  ) {}

  create(
    variables: ActivityCreateVariables,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.create(transaction, this.ownerUserId, variables, clock),
    );
  }

  duplicate(
    activityId: string,
    copyActivityId: string,
    idempotencyKey: string,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.acceptExisting(activityId, (transaction) =>
      this.service.duplicate(
        transaction,
        this.ownerUserId,
        activityId,
        copyActivityId,
        idempotencyKey,
        clock,
      ),
    );
  }

  remove(activityId: string, intentId: string): Promise<NativeActionResult> {
    return this.acceptExisting(activityId, (transaction) =>
      this.service.remove(transaction, { activityId, intentId }),
    );
  }

  convertRecurrence(
    activityId: string,
    selectedDate: string,
    idempotencyKey: string,
  ): Promise<NativeActionResult> {
    return this.acceptExisting(activityId, (transaction) =>
      this.service.appendOnly(transaction, 'convert-recurrence', {
        activityId,
        idempotencyKey,
        input: { selectedDate },
      }),
    );
  }

  patch(
    activityId: string,
    intentId: string,
    input: PatchActivityInput,
    ifMatch: string,
    changeNames?: readonly string[],
  ): Promise<NativeActionResult> {
    const variables: ActivityPatchVariables = {
      activityId,
      intentId,
      input,
      ifMatch,
      ...(changeNames === undefined ? {} : { changeNames }),
    };
    return this.acceptExisting(activityId, (transaction) =>
      this.service.patch(transaction, variables),
    );
  }

  schedule(
    activityId: string,
    idempotencyKey: string,
    input: ScheduleActivityInput,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    const variables: ActivityScheduleVariables = { activityId, idempotencyKey, input };
    return this.acceptExisting(activityId, (transaction) =>
      this.service.schedule(transaction, variables, clock),
    );
  }

  complete(
    activityId: string,
    idempotencyKey: string,
    input: { readonly occurrenceDate?: string; readonly outcome?: ActivityOutcome },
    completed: boolean,
    restoredStatus: 'saved' | 'scheduled',
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    const target = JSON.stringify([activityId, input.occurrenceDate ?? null]);
    const current = this.completionCommits.get(target);
    if (current?.completed === completed) return current.promise;

    const variables: ActivityCompletionVariables = { activityId, idempotencyKey, input };
    const promise = this.acceptExisting(activityId, (transaction) =>
      this.service.complete(transaction, variables, completed, restoredStatus, clock),
    );
    this.completionCommits.set(target, { completed, promise });
    const release = () => {
      if (this.completionCommits.get(target)?.promise === promise) {
        this.completionCommits.delete(target);
      }
    };
    void promise.then(release, release);
    return promise;
  }

  async undoCompletion(
    originalIntentId: string,
    inverse: ActivityCompletionVariables,
    completed: boolean,
    restoredStatus: 'saved' | 'scheduled',
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    try {
      const {
        value: outcome,
        commitRevision,
        metrics,
      } = await this.transactions.runMeasured(async (transaction) => {
        transaction.changed('anytime');
        const original = await this.outbox.get(transaction.database, originalIntentId);
        if (original?.status === 'queued') {
          const cancelled = await this.outbox.cancelQueued(
            transaction.database,
            originalIntentId,
          );
          if (!cancelled) throw new Error('The original action was claimed during Undo.');
          await this.service.projectCompletion(
            transaction,
            inverse,
            completed,
            restoredStatus,
            clock,
          );
          transaction.changed('outbox');
          return { kind: 'cancelled' as const };
        }
        return this.service.complete(
          transaction,
          inverse,
          completed,
          restoredStatus,
          clock,
          original === undefined ? undefined : { originalIntentId },
        );
      }, 'interactive');
      recordNativePerformanceMetric('completion_queue_wait', metrics.queueWaitMs);
      recordNativePerformanceMetric(
        'completion_writer_transaction',
        metrics.transactionMs,
      );
      if (outcome.kind === 'cancelled') return { ...outcome, commitRevision };
      this.sync.request('accepted-action');
      return {
        kind: 'accepted',
        status: 'queued',
        intent: outcome.intent,
        commitRevision,
      };
    } catch (error) {
      return { kind: 'refused', error: asError(error) };
    }
  }

  skip(
    variables: ActivityCompletionVariables,
    skipped: boolean,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.acceptExisting(variables.activityId, (transaction) =>
      this.service.skip(transaction, variables, skipped, clock),
    );
  }

  snooze(
    variables: ActivitySnoozeVariables,
    snoozed: boolean,
    renderedDate: string,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.acceptExisting(variables.activityId, (transaction) =>
      this.service.snooze(transaction, variables, snoozed, renderedDate, clock),
    );
  }

  addReminder(variables: ActivityReminderVariables): Promise<NativeActionResult> {
    return this.acceptExisting(variables.activityId, (transaction) =>
      this.service.addReminder(transaction, this.ownerUserId, variables),
    );
  }

  removeReminder(
    variables: ActivityReminderDeleteVariables,
  ): Promise<NativeActionResult> {
    return this.acceptExisting(variables.activityId, (transaction) =>
      this.service.removeReminder(transaction, variables),
    );
  }

  async cancelPendingCreate(intentId: string): Promise<boolean> {
    return this.transactions.run(async (transaction) => {
      const intent = await this.outbox.get(transaction.database, intentId);
      if (
        intent?.status !== 'queued' ||
        intent.mutationKey[0] !== 'activity' ||
        intent.mutationKey[1] !== 'create'
      ) {
        return false;
      }
      const cancelled = await this.outbox.cancelQueued(transaction.database, intentId);
      if (!cancelled) return false;
      await transaction.database.run(
        'DELETE FROM activity_reminders WHERE activity_id = ?;',
        [intent.entityId],
      );
      await transaction.database.run(
        'DELETE FROM activity_occurrences WHERE activity_id = ?;',
        [intent.entityId],
      );
      await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
        intent.entityId,
      ]);
      await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
        intent.entityId,
      ]);
      transaction.changed(`activity:${intent.entityId}`);
      transaction.changed('agenda');
      transaction.changed('reminders');
      transaction.changed('outbox');
      transaction.changed('anytime');
      return true;
    }, 'interactive');
  }

  async retryBlocked(
    intentId: string,
    freshIntentId: string,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    try {
      const { value: intent, commitRevision } = await this.transactions.runCommitted(
        async (transaction) => {
          const current = await this.outbox.get(transaction.database, intentId);
          if (
            current?.status === 'queued' &&
            current.lastError !== undefined &&
            changesRecurrenceTopology(current)
          ) {
            /* Keep the error actionable until the sync engine actually claims this retry. */
            return current;
          }
          const retried = await this.outbox.retryAttention(
            transaction.database,
            intentId,
            freshIntentId,
          );
          if (retried === undefined || retried.status !== 'queued') {
            throw new Error('This change is no longer waiting for recovery.');
          }
          await this.service.reprojectRetry(
            transaction,
            this.ownerUserId,
            retried,
            clock,
          );
          transaction.changed('outbox');
          transaction.changed('anytime');
          return retried;
        },
        'interactive',
      );
      this.sync.request('accepted-action');
      return { kind: 'accepted', status: 'queued', intent, commitRevision };
    } catch (error) {
      return { kind: 'refused', error: asError(error) };
    }
  }

  async discardBlocked(intentId: string): Promise<boolean> {
    const discarded = await this.transactions.run(async (transaction) => {
      const intent = await this.outbox.get(transaction.database, intentId);
      if (
        intent?.status === 'queued' &&
        intent.lastError !== undefined &&
        changesRecurrenceTopology(intent)
      ) {
        const later = await this.outbox.laterInOrdering(
          transaction.database,
          intent.orderingKey,
          intent.seq,
        );
        if (!(await this.outbox.cancelQueued(transaction.database, intentId))) {
          return false;
        }
        /* Later local writes own the row state; otherwise the cancelled patch was the owner. */
        if (later.length === 0) {
          await this.service.restoreCancelledRecurrenceEdit(transaction, intent.entityId);
        }
        transaction.changed('outbox');
        transaction.changed('anytime');
        return true;
      }
      if (intent?.status !== 'needs_attention') return false;
      if (!(await this.outbox.discardAttention(transaction.database, intentId))) {
        return false;
      }
      if (
        intent.mutationKey[1] === 'create' ||
        (intent.attention?.kind === 'parked' &&
          intent.attention.reason !== 'predecessor_rejected')
      ) {
        await transaction.database.run(
          'DELETE FROM activity_reminders WHERE activity_id = ?;',
          [intent.entityId],
        );
        await transaction.database.run(
          'DELETE FROM activity_occurrences WHERE activity_id = ?;',
          [intent.entityId],
        );
        await transaction.database.run('DELETE FROM agenda_rows WHERE activity_id = ?;', [
          intent.entityId,
        ]);
        await transaction.database.run('DELETE FROM activities WHERE activity_id = ?;', [
          intent.entityId,
        ]);
        transaction.changed(`activity:${intent.entityId}`);
        transaction.changed('agenda');
        transaction.changed('reminders');
      }
      transaction.changed('outbox');
      transaction.changed('anytime');
      return true;
    }, 'interactive');
    if (discarded) this.sync.request('manual');
    return discarded;
  }

  private async accept(
    operation: (transaction: TransactionContext) => Promise<TransactionalIntentResult>,
  ): Promise<NativeActionResult> {
    const startedAt = Date.now();
    try {
      const {
        value: result,
        commitRevision,
        metrics,
      } = await this.transactions.runMeasured(async (transaction) => {
        const accepted = await operation(transaction);
        transaction.changed('anytime');
        return accepted;
      }, 'interactive');
      const mutation = result.intent.mutationKey[1];
      if (mutation === 'complete' || mutation === 'uncomplete') {
        recordNativePerformanceMetric('completion_queue_wait', metrics.queueWaitMs);
        recordNativePerformanceMetric(
          'completion_writer_transaction',
          metrics.transactionMs,
        );
      }
      if (__DEV__) {
        const completedAt = Date.now();
        console.info('native_action_committed', {
          intentId: result.intent.intentId,
          mutation: result.intent.mutationKey.join('.'),
          activityId: result.intent.entityId,
          queueWaitMs: metrics.queueWaitMs,
          transactionMs: metrics.transactionMs,
          sqliteCalls: metrics.callCount,
          sqliteCallMs: metrics.durationMs,
          /* Includes JS work plus native BEGIN/COMMIT and bridge overhead around SQL calls. */
          transactionEnvelopeRemainderMs: Math.max(
            0,
            metrics.transactionMs - metrics.durationMs,
          ),
          commitRevision,
          durationMs: completedAt - startedAt,
        });
      }
      this.sync.request('accepted-action');
      return {
        kind: 'accepted',
        status: 'queued',
        intent: result.intent,
        commitRevision,
      };
    } catch (error) {
      const failure = asError(error);
      if (__DEV__) {
        console.warn('native_action_refused', {
          durationMs: Date.now() - startedAt,
          message: failure.message,
        });
      }
      return { kind: 'refused', error: failure };
    }
  }

  private acceptExisting(
    activityId: string,
    operation: (transaction: TransactionContext) => Promise<TransactionalIntentResult>,
  ): Promise<NativeActionResult> {
    return this.accept(async (transaction) => {
      if (await this.outbox.hasUnacknowledgedCreate(transaction.database, activityId)) {
        throw new Error('This activity will unlock once it finishes syncing.');
      }
      return operation(transaction);
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
