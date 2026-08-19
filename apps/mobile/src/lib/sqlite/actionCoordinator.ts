import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type { ActivityOutcome } from '@od/shared/types';
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
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused'; readonly error: Error };

export class NativeActivityActionCoordinator {
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

  duplicate(activityId: string, idempotencyKey: string): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.appendOnly(transaction, 'duplicate', { activityId, idempotencyKey }),
    );
  }

  remove(activityId: string, intentId: string): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.remove(transaction, { activityId, intentId }),
    );
  }

  convertRecurrence(
    activityId: string,
    selectedDate: string,
    idempotencyKey: string,
  ): Promise<NativeActionResult> {
    return this.accept((transaction) =>
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
    return this.accept((transaction) => this.service.patch(transaction, variables));
  }

  schedule(
    activityId: string,
    idempotencyKey: string,
    input: ScheduleActivityInput,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    const variables: ActivityScheduleVariables = { activityId, idempotencyKey, input };
    return this.accept((transaction) =>
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
    const variables: ActivityCompletionVariables = { activityId, idempotencyKey, input };
    return this.accept((transaction) =>
      this.service.complete(transaction, variables, completed, restoredStatus, clock),
    );
  }

  async undoCompletion(
    originalIntentId: string,
    inverse: ActivityCompletionVariables,
    completed: boolean,
    restoredStatus: 'saved' | 'scheduled',
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    try {
      const outcome = await this.transactions.run(async (transaction) => {
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
      });
      if (outcome.kind === 'cancelled') return outcome;
      this.sync.request('accepted-action');
      return { kind: 'accepted', status: 'queued', intent: outcome.intent };
    } catch (error) {
      return { kind: 'refused', error: asError(error) };
    }
  }

  skip(
    variables: ActivityCompletionVariables,
    skipped: boolean,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.skip(transaction, variables, skipped, clock),
    );
  }

  snooze(
    variables: ActivitySnoozeVariables,
    snoozed: boolean,
    renderedDate: string,
    clock: ProjectionClock,
  ): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.snooze(transaction, variables, snoozed, renderedDate, clock),
    );
  }

  addReminder(variables: ActivityReminderVariables): Promise<NativeActionResult> {
    return this.accept((transaction) =>
      this.service.addReminder(transaction, this.ownerUserId, variables),
    );
  }

  removeReminder(
    variables: ActivityReminderDeleteVariables,
  ): Promise<NativeActionResult> {
    return this.accept((transaction) =>
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
      return true;
    });
  }

  private async accept(
    operation: (transaction: TransactionContext) => Promise<TransactionalIntentResult>,
  ): Promise<NativeActionResult> {
    try {
      const result = await this.transactions.run(operation);
      this.sync.request('accepted-action');
      return { kind: 'accepted', status: 'queued', intent: result.intent };
    } catch (error) {
      return { kind: 'refused', error: asError(error) };
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
