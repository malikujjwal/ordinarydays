import type { ListTemplateSeed } from '@od/shared/lists';
import {
  type CreateListInput,
  type CreateListItemInput,
  createListInput,
  createListItemInput,
  listTemplate,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { pendingListFromInput } from '@/lib/pendingList';
import { pendingListItemFromInput } from '@/lib/pendingListItem';
import type { ListItemsRepository } from '@/lib/sqlite/listItemsRepository';
import type { ListsRepository } from '@/lib/sqlite/listsRepository';
import type { OutboxIntent, OutboxRepository } from '@/lib/sqlite/outbox';
import type { TransactionContext } from '@/lib/sqlite/transaction';

/**
 * One durable create (§P3-26, §P3-05).
 *
 * `listId` and `intentId` are minted **before** this reaches SQLite and are reused by every
 * transport retry: a fresh id on a retry is how one confirmed create becomes two lists. The
 * `seed` travels with the intent rather than being re-resolved at replay, so an app update
 * between queue and drain cannot change what the user made (ADR-032).
 */
export interface ListCreateVariables {
  readonly listId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly input: CreateListInput;
  readonly seed: ListTemplateSeed;
}

/**
 * One durable item create (P3-27, §P3-08).
 *
 * `itemId` and `intentId` are minted at confirmation and reused by every replay, for the
 * reason the List create records: a fresh id on a retry is how one create becomes two rows.
 *
 * `rank` is the position the device **showed** the row at, carried so a Retry after an
 * authoritative rollback puts it back where the user last saw it rather than recomputing a
 * position against a list that has moved on. The server still allocates the real one.
 */
export interface ListItemCreateVariables {
  readonly listId: string;
  readonly itemId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly input: CreateListItemInput;
  readonly rank: string;
}

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

/**
 * The seed as it comes back out of SQLite.
 *
 * **Picked from the canonical `listTemplate` schema**, never restated: the shape is owned by
 * `packages/shared` and a second declaration here would be a copy that could disagree with the
 * catalogue it describes.
 */
const persistedSeed = listTemplate.pick({
  behaviour: true,
  capabilities: true,
  slot: true,
  icon: true,
  emptyStateCopy: true,
});

/**
 * Reads a persisted create back into its typed variables.
 *
 * Both halves are parsed, not cast, because a payload written by an older build has to fail
 * loudly here rather than be sent as something the server will reject or rebuilt as a row that
 * renders wrongly. The messages are the ones the recovery banner shows, so they say what the
 * person can do about it.
 */
function parseCreateVariables(variables: object, listId: string): ListCreateVariables {
  const parsed = createListInput.safeParse(Reflect.get(variables, 'input'));
  const intentId = Reflect.get(variables, 'intentId');
  const idempotencyKey = Reflect.get(variables, 'idempotencyKey');
  const seed = Reflect.get(variables, 'seed');
  if (!parsed.success || parsed.data.listId !== listId) {
    throw new Error('The saved list create is invalid. Discard it and try again.');
  }
  if (typeof intentId !== 'string' || typeof idempotencyKey !== 'string') {
    throw new Error('The saved list create has no retry identity.');
  }
  const seedFields = persistedSeed.safeParse(seed);
  if (!seedFields.success) {
    throw new Error('The saved list create is missing its copied style.');
  }
  return {
    listId,
    intentId,
    idempotencyKey,
    input: parsed.data,
    seed: seedFields.data,
  };
}

function parseItemCreateVariables(
  variables: object,
  itemId: string,
): ListItemCreateVariables {
  const parsed = createListItemInput.safeParse(Reflect.get(variables, 'input'));
  const listId = Reflect.get(variables, 'listId');
  const intentId = Reflect.get(variables, 'intentId');
  const idempotencyKey = Reflect.get(variables, 'idempotencyKey');
  const rank = Reflect.get(variables, 'rank');
  if (!parsed.success || parsed.data.itemId !== itemId) {
    throw new Error('The saved item is invalid. Discard it and try again.');
  }
  if (
    typeof listId !== 'string' ||
    typeof intentId !== 'string' ||
    typeof idempotencyKey !== 'string' ||
    typeof rank !== 'string'
  ) {
    throw new Error('The saved item has no retry identity.');
  }
  return { listId, itemId, intentId, idempotencyKey, input: parsed.data, rank };
}

/** Commits each visible List-index mutation with its durable outbox intent. */
export class ListTransactionService {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly lists: ListsRepository,
    private readonly items?: ListItemsRepository,
  ) {}

  /**
   * The visible item and its queued create, in one commit (P3-27).
   *
   * The ordering key names the **list**, not the item, and that is deliberate on both counts:
   * items typed in sequence reach the server in that sequence, and an item create serialises
   * behind an archive or a delete of the same list rather than racing it. The identity being
   * re-minted on a collision Retry is still the item's, which is why the remap must move the
   * entity without touching this key.
   */
  async createItem(
    transaction: TransactionContext,
    variables: ListItemCreateVariables,
    projectExisting = false,
  ): Promise<OutboxIntent> {
    const items = this.requireItems();
    if (variables.input.itemId !== variables.itemId) {
      throw new Error('A durable item create must carry its minted identity.');
    }
    const appended = await this.outbox.append(transaction.database, {
      intentId: variables.intentId,
      mutationKey: ['list', 'item-create'],
      variables,
      entityId: variables.itemId,
      orderingKey: `list:${variables.listId}`,
    });
    if (appended.kind === 'inserted' || projectExisting) {
      await items.insertPendingCreate(
        transaction,
        pendingListItemFromInput(
          variables.input,
          variables.listId,
          variables.itemId,
          variables.rank,
        ),
      );
    }
    transaction.changed('outbox');
    return appended.intent;
  }

  /** Installs the server's item over the optimistic row once its create is acknowledged. */
  async acceptCreatedItem(
    transaction: TransactionContext,
    item: Parameters<ListItemsRepository['acceptCreated']>[1],
  ): Promise<void> {
    await this.requireItems().acceptCreated(transaction, item);
  }

  /** Moves one unsynced item onto a freshly minted identity after an explicit Retry. */
  async remapPendingItemCreateIdentity(
    transaction: TransactionContext,
    listId: string,
    previousItemId: string,
    freshItemId: string,
  ): Promise<void> {
    await this.requireItems().remapPendingCreate(
      transaction,
      listId,
      previousItemId,
      freshItemId,
    );
  }

  private requireItems(): ListItemsRepository {
    if (this.items === undefined) {
      throw new Error('Native list item state is not ready.');
    }
    return this.items;
  }

  /**
   * The visible row and the queued create, in one commit.
   *
   * The order is the contract §P3-26 states: the id is minted, then the row and the intent are
   * written **atomically**. A row without its intent is a list that never syncs; an intent
   * without its row is a create the user cannot see they made. `append` is idempotent for a
   * canonically equivalent payload, so a repeated confirmation resolves to the one intent that
   * already exists and projects nothing twice.
   */
  async create(
    transaction: TransactionContext,
    ownerUserId: string,
    variables: ListCreateVariables,
    mintedAt = systemClock.now(),
    projectExisting = false,
  ): Promise<OutboxIntent> {
    if (variables.input.listId !== variables.listId) {
      throw new Error('A durable list create must carry its minted identity.');
    }
    const appended = await this.outbox.append(transaction.database, {
      intentId: variables.intentId,
      mutationKey: ['list', 'create'],
      variables,
      entityId: variables.listId,
      orderingKey: `list:${variables.listId}`,
    });
    if (appended.kind === 'inserted' || projectExisting) {
      await this.lists.insertPendingCreate(
        transaction,
        pendingListFromInput(
          variables.input,
          variables.seed,
          variables.listId,
          ownerUserId,
          mintedAt,
        ),
      );
    }
    transaction.changed('outbox');
    return appended.intent;
  }

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

  /**
   * Moves the local row of a parked create onto a freshly minted identity.
   *
   * The row rather than a new one, so the list the user is looking at keeps its ordinal and
   * its content and simply changes the name it will be stored under. Its dependent outbox
   * references are re-pointed by `retryAmbiguousCreate` in the same transaction.
   */
  async remapPendingCreateIdentity(
    transaction: TransactionContext,
    previousListId: string,
    freshListId: string,
  ): Promise<void> {
    await this.lists.remapPendingCreate(transaction, previousListId, freshListId);
  }

  /** Re-applies a user-directed Retry after authoritative rollback restored the List index. */
  async reprojectRetry(
    transaction: TransactionContext,
    ownerUserId: string,
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

    if (intent.mutationKey[1] === 'item-create') {
      /*
       * The rollback removed the row this create was showing. Put it back from the durable
       * payload, at the rank the user saw it at.
       */
      await this.createItem(
        transaction,
        parseItemCreateVariables(variables, intent.entityId),
        true,
      );
      return intent;
    }
    if (intent.mutationKey[1] === 'create') {
      /*
       * The rollback removed the row this create was showing, so the retry has to put it back
       * — from the durable payload, which carries the seed frozen at confirmation rather than
       * whatever the shipped catalogue says now.
       */
      await this.create(
        transaction,
        ownerUserId,
        parseCreateVariables(variables, intent.entityId),
        undefined,
        true,
      );
      return intent;
    }
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
