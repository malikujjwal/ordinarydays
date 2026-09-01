import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type { ActivityOutcome } from '@od/shared/types';
import {
  changesRecurrenceTopology,
  isListItemProjectionMutation,
  isListMutation,
} from '@/lib/mutationKeys';
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
import type { ListTransactionService } from '@/lib/sqlite/listTransactions';
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
    private readonly activityIdFactory?: () => string,
    private readonly listService?: ListTransactionService,
    private readonly listIdFactory?: () => string,
    private readonly listItemIdFactory?: () => string,
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
    clock?: ProjectionClock,
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
      this.service.patch(transaction, variables, clock),
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
      const blocked = await this.transactions.run((transaction) =>
        this.outbox.get(transaction.database, intentId),
      );
      const requiresRecovery =
        blocked?.status === 'needs_attention' &&
        !isAmbiguousCollision(blocked) &&
        (blocked.mutationKey[0] === 'list' ||
          blocked.recoveryRequired === true ||
          isRetryExhausted(blocked));
      const recovery = requiresRecovery
        ? await this.sync.prepareRejectedIntentRecovery(intentId)
        : undefined;
      if (requiresRecovery && recovery === undefined) {
        throw new Error("Couldn't refresh the latest saved state before retrying.");
      }
      const { value: intent, commitRevision } = await this.transactions.runCommitted(
        async (transaction) => {
          if (recovery !== undefined && !(await recovery.install(transaction))) {
            throw new Error("Couldn't refresh the latest saved state before retrying.");
          }
          const current = await this.outbox.get(transaction.database, intentId);
          if (
            current?.status === 'queued' &&
            current.lastError !== undefined &&
            changesRecurrenceTopology(current)
          ) {
            /*
             * Keep the error actionable until the sync engine claims this retry, but repair
             * projections written by an older app build before recurrence timing was local.
             */
            await this.service.reprojectRetry(
              transaction,
              this.ownerUserId,
              current,
              clock,
            );
            transaction.changed('anytime');
            return current;
          }
          if (current !== undefined && isAmbiguousCollision(current)) {
            /*
             * The one place a second identity is minted, and only because the user asked for
             * it. `retryAmbiguousCreate` moves the whole dependent chain onto it inside this
             * transaction, so nothing is left naming the id the server refused.
             */
            const domain =
              current.mutationKey[0] === 'list'
                ? current.mutationKey[1] === 'item-create'
                  ? 'listItem'
                  : 'list'
                : 'activity';
            if (domain !== 'activity' && this.listService === undefined) {
              throw new Error('Native List retry state is not ready.');
            }
            const mint = async (prefix: 'act' | 'lst' | 'itm') =>
              (await import('@/lib/canonicalIds')).nextCanonicalId(prefix);
            if (domain === 'listItem') {
              const listId = Reflect.get(
                typeof current.variables === 'object' && current.variables !== null
                  ? current.variables
                  : {},
                'listId',
              );
              if (typeof listId !== 'string') {
                throw new Error('This saved item no longer names a list.');
              }
              const freshItemId = this.listItemIdFactory?.() ?? (await mint('itm'));
              await this.listService?.remapPendingItemCreateIdentity(
                transaction,
                listId,
                current.entityId,
                freshItemId,
              );
              const retriedItem = await this.outbox.retryAmbiguousCreate(
                transaction.database,
                intentId,
                freshIntentId,
                freshItemId,
              );
              if (retriedItem === undefined || retriedItem.status !== 'queued') {
                throw new Error(
                  'This create is no longer waiting for collision recovery.',
                );
              }
              transaction.changed('outbox');
              return retriedItem;
            }
            const freshEntityId =
              domain === 'list'
                ? (this.listIdFactory?.() ?? (await mint('lst')))
                : (this.activityIdFactory?.() ?? (await mint('act')));
            if (domain === 'list') {
              await this.listService?.remapPendingCreateIdentity(
                transaction,
                current.entityId,
                freshEntityId,
              );
            } else {
              await this.service.remapPendingCreateIdentity(
                transaction,
                current.entityId,
                freshEntityId,
              );
            }
            const retried = await this.outbox.retryAmbiguousCreate(
              transaction.database,
              intentId,
              freshIntentId,
              freshEntityId,
            );
            if (retried === undefined || retried.status !== 'queued') {
              throw new Error('This create is no longer waiting for collision recovery.');
            }
            transaction.changed('outbox');
            return retried;
          }
          const responseLoss = current !== undefined && isRetryExhausted(current);
          const retried = responseLoss
            ? await this.outbox.retryResponseLoss(transaction.database, intentId)
            : await this.outbox.retryAttention(
                transaction.database,
                intentId,
                freshIntentId,
              );
          if (retried === undefined || retried.status !== 'queued') {
            throw new Error('This change is no longer waiting for recovery.');
          }
          if (retried.mutationKey[0] === 'list') {
            if (this.listService === undefined) {
              throw new Error('Native List retry state is not ready.');
            }
            if (!responseLoss) {
              await this.outbox.reidentifyListArchiveUndoOffer(
                transaction.database,
                intentId,
                freshIntentId,
              );
              if (isListMutation(retried, 'itemUndo')) {
                await this.outbox.reidentifyListItemUndoIntent(
                  transaction.database,
                  intentId,
                  freshIntentId,
                );
              } else {
                await this.outbox.reidentifyListItemDeleteUndoOffer(
                  transaction.database,
                  intentId,
                  freshIntentId,
                );
              }
            }
            const projected = await this.reprojectIntent(transaction, retried, clock);
            await this.reprojectLaterIntents(transaction, retried, clock);
            transaction.changed('outbox');
            transaction.changed('anytime');
            return projected;
          } else {
            const projected = await this.reprojectIntent(transaction, retried, clock);
            await this.reprojectLaterIntents(transaction, retried, clock);
            transaction.changed('outbox');
            transaction.changed('anytime');
            return projected;
          }
        },
        'interactive',
      );
      this.sync.request('accepted-action');
      return { kind: 'accepted', status: 'queued', intent, commitRevision };
    } catch (error) {
      return { kind: 'refused', error: asError(error) };
    }
  }

  async discardBlocked(intentId: string, clock: ProjectionClock): Promise<boolean> {
    const recovery = await this.transactions.run((transaction) =>
      this.outbox.get(transaction.database, intentId),
    );
    if (
      recovery === undefined ||
      (recovery.status !== 'needs_attention' &&
        !(
          recovery.status === 'queued' &&
          recovery.lastError !== undefined &&
          changesRecurrenceTopology(recovery)
        ))
    ) {
      // Idempotent completion also clears a presentation snapshot that lost a race with SQLite.
      return true;
    }
    const requiresRecovery =
      recovery?.mutationKey[0] === 'list' ||
      recovery?.recoveryRequired === true ||
      (recovery !== undefined && isRetryExhausted(recovery));
    const prepared = requiresRecovery
      ? await this.sync.prepareRejectedIntentRecovery(intentId)
      : undefined;
    if (requiresRecovery && prepared === undefined) return false;
    const discarded = await this.transactions.run(async (transaction) => {
      if (prepared !== undefined && !(await prepared.install(transaction))) {
        return false;
      }
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
          await this.service.restoreCancelledRecurrenceEdit(transaction, intent, clock);
        }
        transaction.changed('outbox');
        transaction.changed('anytime');
        return true;
      }
      if (intent?.status !== 'needs_attention') return false;
      /* Never bless an unverified rejected projection by deleting its only recovery receipt. */
      if (intent.recoveryRequired === true) return false;
      if (!(await this.outbox.discardAttention(transaction.database, intentId))) {
        return false;
      }
      if (prepared?.targetState === 'absent') {
        await this.discardLaterForAbsentTarget(transaction, intent);
        transaction.changed('outbox');
        transaction.changed('anytime');
        return true;
      }
      if (intent.mutationKey[0] === 'list') {
        await this.reprojectLaterIntents(transaction, intent, clock);
        transaction.changed('outbox');
        return true;
      }
      if (
        !isRetryExhausted(intent) &&
        (intent.mutationKey[1] === 'create' ||
          (intent.attention?.kind === 'parked' &&
            intent.attention.reason !== 'predecessor_rejected'))
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
      await this.reprojectLaterIntents(transaction, intent, clock);
      transaction.changed('outbox');
      transaction.changed('anytime');
      return true;
    }, 'interactive');
    if (discarded) this.sync.request('manual');
    return discarded;
  }

  /** Re-applies one unresolved durable projection without changing its queue identity. */
  private async reprojectIntent(
    transaction: TransactionContext,
    intent: OutboxIntent,
    clock: ProjectionClock,
  ): Promise<OutboxIntent> {
    if (intent.mutationKey[0] === 'list') {
      if (this.listService === undefined) {
        throw new Error('Native List retry state is not ready.');
      }
      return this.listService.reprojectRetry(transaction, this.ownerUserId, intent);
    }
    await this.service.reprojectRetry(transaction, this.ownerUserId, intent, clock);
    return (await this.outbox.get(transaction.database, intent.intentId)) ?? intent;
  }

  /**
   * Canonical recovery intentionally overwrites one ordering domain. Restore every surviving
   * later projection in FIFO order before the user action commits, and release writes that
   * were parked only because this predecessor needed a decision.
   */
  private async reprojectLaterIntents(
    transaction: TransactionContext,
    predecessor: OutboxIntent,
    clock: ProjectionClock,
  ): Promise<void> {
    const later = await this.outbox.laterInOrdering(
      transaction.database,
      predecessor.orderingKey,
      predecessor.seq,
    );
    for (const candidate of later) {
      let current = await this.outbox.get(transaction.database, candidate.intentId);
      if (
        current?.status === 'needs_attention' &&
        current.attention?.kind === 'parked' &&
        current.attention.reason === 'predecessor_rejected'
      ) {
        current = await this.outbox.resumePredecessorBlocked(
          transaction.database,
          current.intentId,
        );
      }
      if (current === undefined) continue;
      await this.reprojectIntent(transaction, current, clock);
    }
  }

  /**
   * Later writes against a target proven absent have no truthful projection or remote target.
   * Discarding the root therefore retires the same-entity FIFO suffix atomically; keeping it
   * queued would create an orphan retry loop, while replaying it would redraw data the server
   * has authoritatively said does not exist.
   */
  private async discardLaterForAbsentTarget(
    transaction: TransactionContext,
    predecessor: OutboxIntent,
  ): Promise<void> {
    /*
     * A List item is one target inside a List-wide FIFO domain, so an absent item retires only
     * that item's successors. An absent List root proves the aggregate itself is gone: every
     * later item and settings write in the same ordering suffix is then orphaned work.
     */
    const discardWholeOrderingSuffix =
      predecessor.mutationKey[0] === 'list' && !isListItemProjectionMutation(predecessor);
    const later = await this.outbox.laterInOrdering(
      transaction.database,
      predecessor.orderingKey,
      predecessor.seq,
    );
    for (const candidate of later) {
      if (!discardWholeOrderingSuffix && candidate.entityId !== predecessor.entityId) {
        continue;
      }
      if (!(await this.outbox.discardUnsent(transaction.database, candidate.intentId))) {
        throw new Error('Later work became active during absent-target recovery.');
      }
    }
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

/**
 * A create whose minted id the server refused and whose owner this device could not read.
 *
 * The one recovery that re-mints, and the reason it is a named predicate: every *other*
 * blocked List intent must refresh authoritative state before retrying, and this one must
 * not — the `404` that parked it already established there is nothing to refresh.
 */
function isAmbiguousCollision(intent: OutboxIntent): boolean {
  return (
    intent.status === 'needs_attention' &&
    (intent.mutationKey[1] === 'create' || intent.mutationKey[1] === 'item-create') &&
    intent.attention?.kind === 'parked' &&
    intent.attention.reason === 'ambiguous_collision'
  );
}

function isRetryExhausted(intent: OutboxIntent): boolean {
  return (
    intent.attention?.kind === 'parked' && intent.attention.reason === 'retry_exhausted'
  );
}
