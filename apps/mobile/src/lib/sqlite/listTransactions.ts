import type { List } from '@od/shared/types';
import type { ListsRepository } from '@/lib/sqlite/listsRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export interface ListPatchVariables {
  readonly listId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly input: { readonly archived: boolean };
  readonly ifMatch: string;
}

export interface ListDeleteVariables {
  readonly listId: string;
  readonly intentId: string;
}

export interface ListUndoVariables {
  readonly listId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly originalIntentId: string;
  /** Absent only while the archive dependency is still awaiting its server receipt. */
  readonly undoToken?: string;
}

/** Commits each visible List-index mutation with its durable outbox intent. */
export class ListTransactionService {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly lists: ListsRepository,
  ) {}

  async setArchived(
    transaction: TransactionContext,
    list: List,
    archived: boolean,
    intentId: string,
  ): Promise<OutboxIntent> {
    const current = await this.lists.getLocal(transaction.database, list.listId);
    if (current === undefined)
      throw new Error('The list is no longer available locally.');
    const variables: ListPatchVariables = {
      listId: list.listId,
      intentId,
      idempotencyKey: intentId,
      input: { archived },
      // The card callback can outlive acknowledgement of an earlier archive. Reading inside
      // this transaction makes an Undo use the latest committed canonical version, while a
      // still-queued predecessor retains its original version and is rebased on settlement.
      ifMatch: current.updatedAt,
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId,
      mutationKey: ['list', 'patch'],
      variables,
      entityId: list.listId,
      orderingKey: `list:${list.listId}`,
    });
    if (appended.kind === 'inserted') {
      await this.lists.setArchivedLocal(transaction, list.listId, archived);
      if (archived) {
        await this.outbox.createListArchiveUndoOffer(
          transaction.database,
          intentId,
          list.listId,
        );
      }
    }
    transaction.changed('outbox');
    return appended.intent;
  }

  /**
   * Accepts archive Undo as a durable compensation, never as a reconstructed PATCH.
   * If the forward write has not left the queue yet, cancelling it is the exact inverse.
   */
  async undoArchive(
    transaction: TransactionContext,
    listId: string,
    originalIntentId: string,
    inverseIntentId: string,
  ): Promise<{ readonly kind: 'cancelled' | 'queued'; readonly intent?: OutboxIntent }> {
    const offer = await this.outbox.listArchiveUndoOffer(
      transaction.database,
      originalIntentId,
    );
    if (offer === undefined || offer.listId !== listId) {
      throw new Error('This archive Undo offer is no longer available.');
    }
    const original = await this.outbox.get(transaction.database, offer.currentIntentId);
    if (original?.status === 'queued' && original.attempts === 0) {
      if (
        !(await this.outbox.cancelQueued(transaction.database, offer.currentIntentId))
      ) {
        throw new Error('The archive started syncing before it could be cancelled.');
      }
      await this.outbox.clearListArchiveUndoOffer(transaction.database, originalIntentId);
      await this.lists.setArchivedLocal(transaction, listId, false);
      transaction.changed('outbox');
      return { kind: 'cancelled' };
    }
    if (original?.status === 'needs_attention') {
      throw new Error('The archive needs recovery before it can be undone.');
    }
    if (
      offer.undoToken === undefined &&
      original?.status !== 'in_flight' &&
      !(original?.status === 'queued' && original.attempts > 0)
    ) {
      throw new Error('The archive acknowledgement did not provide an Undo token.');
    }
    const variables: ListUndoVariables = {
      listId,
      intentId: inverseIntentId,
      idempotencyKey: inverseIntentId,
      originalIntentId,
      ...(offer.undoToken === undefined ? {} : { undoToken: offer.undoToken }),
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId: inverseIntentId,
      mutationKey: ['list', 'undo'],
      variables,
      entityId: listId,
      orderingKey: `list:${listId}`,
      ...(original === undefined ? {} : { dependsOnIntentId: original.intentId }),
      ...(original === undefined ? {} : { compensationForIntentId: original.intentId }),
    });
    if (appended.kind === 'inserted') {
      await this.outbox.linkListArchiveUndoIntent(
        transaction.database,
        originalIntentId,
        inverseIntentId,
      );
      await this.lists.setArchivedLocal(transaction, listId, false);
    }
    transaction.changed('outbox');
    return { kind: 'queued', intent: appended.intent };
  }

  async commitArchiveUndoOffer(
    transaction: TransactionContext,
    originalIntentId: string,
  ): Promise<void> {
    await this.outbox.clearListArchiveUndoOffer(
      transaction.database,
      originalIntentId,
      true,
    );
  }

  async remove(
    transaction: TransactionContext,
    list: List,
    intentId: string,
  ): Promise<void> {
    const variables: ListDeleteVariables = { listId: list.listId, intentId };
    const appended = await this.outbox.append(transaction.database, {
      intentId,
      mutationKey: ['list', 'delete'],
      variables,
      entityId: list.listId,
      orderingKey: `list:${list.listId}`,
    });
    if (appended.kind === 'inserted') {
      await this.lists.removeCanonical(transaction, list.listId);
    }
    transaction.changed('outbox');
  }

  /** Re-applies a user-directed Retry after authoritative rollback restored the List index. */
  async reprojectRetry(
    transaction: TransactionContext,
    intent: OutboxIntent,
  ): Promise<OutboxIntent> {
    if (intent.mutationKey[0] !== 'list') {
      throw new Error('A non-List intent reached List retry projection.');
    }
    const variables =
      typeof intent.variables === 'object' && intent.variables !== null
        ? intent.variables
        : undefined;
    if (variables === undefined) throw new Error('The List retry payload is malformed.');

    if (intent.mutationKey[1] === 'patch') {
      const input = Reflect.get(variables, 'input');
      const archived =
        typeof input === 'object' && input !== null
          ? Reflect.get(input, 'archived')
          : undefined;
      if (typeof archived !== 'boolean') {
        throw new Error('The List settings retry payload is malformed.');
      }
      const current = await this.lists.getLocal(transaction.database, intent.entityId);
      if (current === undefined) {
        throw new Error('The list is no longer available locally.');
      }
      const rebased = await this.outbox.rebaseListPatchIntent(
        transaction.database,
        intent.intentId,
        current.updatedAt,
      );
      const undoOffer = await this.outbox.listArchiveUndoOffer(
        transaction.database,
        intent.intentId,
      );
      await this.lists.setArchivedLocal(
        transaction,
        intent.entityId,
        undoOffer?.inverseIntentId === undefined ? archived : false,
      );
      return rebased;
    }
    if (intent.mutationKey[1] === 'delete') {
      await this.lists.removeCanonical(transaction, intent.entityId);
      return intent;
    }
    throw new Error(
      `Unsupported blocked List mutation: ${intent.mutationKey[1] ?? 'unknown'}.`,
    );
  }
}
