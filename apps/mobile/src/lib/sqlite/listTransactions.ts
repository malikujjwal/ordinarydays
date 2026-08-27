import type { List } from '@od/shared/types';
import type { ListsRepository } from '@/lib/sqlite/listsRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { TransactionContext } from '@/lib/sqlite/transaction';

export interface ListPatchVariables {
  readonly listId: string;
  readonly intentId: string;
  readonly input: { readonly archived: boolean };
  readonly ifMatch: string;
}

export interface ListDeleteVariables {
  readonly listId: string;
  readonly intentId: string;
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
  ): Promise<void> {
    const current = await this.lists.getLocal(transaction.database, list.listId);
    if (current === undefined)
      throw new Error('The list is no longer available locally.');
    const variables: ListPatchVariables = {
      listId: list.listId,
      intentId,
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
    }
    transaction.changed('outbox');
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
  ): Promise<void> {
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
      if (
        (await this.lists.getLocal(transaction.database, intent.entityId)) === undefined
      ) {
        throw new Error('The list is no longer available locally.');
      }
      await this.lists.setArchivedLocal(transaction, intent.entityId, archived);
      return;
    }
    if (intent.mutationKey[1] === 'delete') {
      await this.lists.removeCanonical(transaction, intent.entityId);
      return;
    }
    throw new Error(
      `Unsupported blocked List mutation: ${intent.mutationKey[1] ?? 'unknown'}.`,
    );
  }
}
