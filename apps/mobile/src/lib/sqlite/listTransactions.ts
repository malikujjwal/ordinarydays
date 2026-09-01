import type { PatchListItemInput } from '@od/shared/client';
import type { ListTemplateSeed } from '@od/shared/lists';
import {
  type CreateListInput,
  type CreateListItemInput,
  createListInput,
  createListItemInput,
  listItemView,
  listTemplate,
  type PatchListInput,
  patchListInput,
  patchListItemInput,
} from '@od/shared/schemas';
import { systemClock } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { isListMutation, listMutationKeys } from '@/lib/mutationKeys';
import { pendingListFromInput } from '@/lib/pendingList';
import { pendingListItemFromInput } from '@/lib/pendingListItem';
import type { ListItemRow, ListItemsRepository } from '@/lib/sqlite/listItemsRepository';
import type { ListsRepository, LocalListSettings } from '@/lib/sqlite/listsRepository';
import {
  type OutboxIntent,
  type OutboxRepository,
  undoOfferInverseIntentId,
  undoOfferReceipt,
} from '@/lib/sqlite/outbox';
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

/**
 * One durable item field edit (P3-29, §5.11.5).
 *
 * No `ifMatch`, unlike {@link ListPatchVariables}: item writes are per-field last-write-wins,
 * and optimistic concurrency on every checkbox in a grocery list would produce constant
 * spurious `409`s in exactly the situation the feature exists for. The `idempotencyKey` is
 * carried for the outbox's own identity rather than for the route, which is not
 * replay-protected — a repeated PATCH of the same value is the same outcome.
 */
export interface ListItemPatchVariables {
  readonly listId: string;
  readonly itemId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly input: PatchListItemInput;
}

/**
 * One durable item delete. The previous row is a rollback snapshot only; it is never sent as
 * server authority. The server-authored opaque Undo token remains the only inverse on the wire.
 */
export interface ListItemDeleteVariables {
  readonly listId: string;
  readonly itemId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly previous: ListItemRow;
}

export type EnqueueListItemDelete = Omit<ListItemDeleteVariables, 'previous'>;

function savedListItem(value: unknown): ListItemRow | undefined {
  const parsed = listItemView.safeParse(value);
  // The wire schema permits `undefined` while the canonical domain expresses it as absence.
  return parsed.success ? (parsed.data as ListItemRow) : undefined;
}

export interface ListItemUndoVariables {
  readonly listId: string;
  readonly itemId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly originalIntentId: string;
  readonly receipt:
    | { readonly kind: 'pending' }
    | { readonly kind: 'ready'; readonly undoToken: string };
}

/**
 * One durable List **settings** write (P3-25's archive, P3-32's rename, capabilities and slot).
 *
 * `input` is the whole `PatchListInput` rather than the archive flag it started as: §P3-32's
 * three additive controls are the same route, the same `If-Match` and the same opaque Undo
 * token as archiving, so they ride the same intent instead of acquiring a second one that would
 * have to be ordered against it.
 *
 * ## `previous` is a projection, never an inverse
 *
 * It is the local row's values before this write, and it exists for exactly one job: drawing the
 * old state again the instant Undo is tapped, before the server's compensation has run. The
 * **real** inverse stays where `undoListOperation` documents it — on the server, behind an
 * opaque token — and nothing here sends these values back as authority. `setArchivedLocal` has
 * always done the same thing for archiving; this only stops it being hard-coded to one field.
 */
export interface ListPatchVariables {
  readonly listId: string;
  readonly intentId: string;
  readonly idempotencyKey: string;
  readonly input: PatchListInput;
  readonly ifMatch: string;
  /** The committed values this write replaced, for the optimistic half of Undo. */
  readonly previous?: LocalListSettings;
}

/**
 * One durable behaviour change — the P3-32 inventory extension (§P3-09, §P3-32).
 *
 * A separate mutation key from `['list','patch']` because it is a separate **route**:
 * `patchListInput` has no `behaviour` field by type, and the server runs a gated, resumable item
 * migration rather than one conditional `META` write. Sharing the patch key would mean a push
 * adapter guessing which endpoint a payload meant.
 *
 * `input.confirmation` is present only for a confirmed destructive downgrade, and it is the
 * server's own preview echoed **whole**. An unconfirmed downgrade never reaches this type: that
 * call is a direct online preview with its own key and is deliberately not accepted into the
 * outbox, because a question the user has not answered must not survive the app being closed.
 *
 * `idempotencyKey` identifies the *migration*, so a replay resumes the work already started
 * rather than beginning a second pass over the same items.
 */
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
  itemStateMode: true,
  featureConfig: true,
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
    seed: seedFields.data as ListTemplateSeed,
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

function parseItemPatchVariables(
  variables: object,
  itemId: string,
): ListItemPatchVariables {
  const parsed = patchListItemInput.safeParse(Reflect.get(variables, 'input'));
  const listId = Reflect.get(variables, 'listId');
  const intentId = Reflect.get(variables, 'intentId');
  const idempotencyKey = Reflect.get(variables, 'idempotencyKey');
  if (!parsed.success) {
    throw new Error('The saved edit is invalid. Discard it and try again.');
  }
  if (
    typeof listId !== 'string' ||
    typeof intentId !== 'string' ||
    typeof idempotencyKey !== 'string'
  ) {
    throw new Error('The saved edit has no retry identity.');
  }
  return { listId, itemId, intentId, idempotencyKey, input: parsed.data };
}

/** The persisted settings payload, parsed rather than read field by field. */
function parsePersistedPatch(variables: object): PatchListInput {
  const parsed = patchListInput.safeParse(Reflect.get(variables, 'input'));
  if (!parsed.success) {
    throw new Error('The saved list change is invalid. Discard it and try again.');
  }
  return parsed.data;
}

/** The patch, as the columns the optimistic row draws from. One shape, no re-interpretation. */
function localSettingsFrom(patch: PatchListInput): LocalListSettings {
  return {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.slot === undefined ? {} : { slot: patch.slot }),
    ...(patch.archived === undefined ? {} : { archived: patch.archived }),
    ...(patch.itemStateMode === undefined
      ? {}
      : { itemStateMode: patch.itemStateMode as List['itemStateMode'] }),
    ...(patch.featureConfig === undefined
      ? {}
      : { featureConfig: patch.featureConfig as List['featureConfig'] }),
  };
}

/**
 * The committed values for exactly the fields this patch names, and no others.
 *
 * Narrowed to the patch rather than snapshotting the whole row, because Undo has to put back
 * what *this* operation changed. A whole-row snapshot would also restore a rename somebody made
 * in between, which is the "never replaces the List with a whole-list snapshot" rule §P3-10
 * states for items, applied to settings.
 */
function previousSettingsFor(current: List, patch: PatchListInput): LocalListSettings {
  return {
    ...(patch.title === undefined ? {} : { title: current.title }),
    ...(patch.slot === undefined ? {} : { slot: current.slot }),
    ...(patch.archived === undefined ? {} : { archived: current.archived }),
    ...(patch.itemStateMode === undefined
      ? {}
      : { itemStateMode: current.itemStateMode }),
    ...(patch.featureConfig === undefined
      ? {}
      : { featureConfig: current.featureConfig }),
  };
}

/**
 * Whether the server will retain an inverse for this patch.
 *
 * Every additive settings field does; a rename does not, because `interaction-contract.md` §4.1
 * has no undo row for renaming a list. Creating an offer for a title-only patch would leave a
 * row waiting forever for a token the response is never going to carry.
 */
function recordsInverse(patch: PatchListInput): boolean {
  return (
    patch.title !== undefined ||
    patch.itemStateMode !== undefined ||
    patch.featureConfig !== undefined ||
    patch.slot !== undefined ||
    patch.archived !== undefined
  );
}

function doneCountForState(state: ListItemRow['state'] | undefined): number {
  return state === 'done' ? 1 : 0;
}

/**
 * The forward intent's recorded projection, for the local half of an accepted Undo.
 *
 * Parsed defensively and never required: an intent written before this field existed simply
 * restores nothing locally, and the server's compensation — the only authority for what really
 * goes back — still runs. Refusing the Undo instead would strand the offer.
 */
function previousSettingsOf(intent: OutboxIntent | undefined): LocalListSettings {
  const variables = intent?.variables;
  if (typeof variables !== 'object' || variables === null) return {};
  const previous = Reflect.get(variables, 'previous');
  if (typeof previous !== 'object' || previous === null) return {};
  const itemStateMode = Reflect.get(previous, 'itemStateMode');
  const featureConfig = Reflect.get(previous, 'featureConfig');
  const title = Reflect.get(previous, 'title');
  const slot = Reflect.get(previous, 'slot');
  const archived = Reflect.get(previous, 'archived');
  return {
    ...(typeof title === 'string' ? { title } : {}),
    ...(slot === null || typeof slot === 'string' ? { slot: slot as List['slot'] } : {}),
    ...(typeof archived === 'boolean' ? { archived } : {}),
    ...(typeof itemStateMode === 'object' && itemStateMode !== null
      ? { itemStateMode: itemStateMode as List['itemStateMode'] }
      : {}),
    ...(typeof featureConfig === 'object' && featureConfig !== null
      ? { featureConfig: featureConfig as List['featureConfig'] }
      : {}),
  };
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
    const current = await items.getLocal(variables.itemId, transaction.database);
    const appended = await this.outbox.append(transaction.database, {
      intentId: variables.intentId,
      mutationKey: listMutationKeys.itemCreate,
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
      if (current === undefined) {
        await this.lists.applyLocalItemDelta(transaction, variables.listId, {
          itemCount: 1,
          doneCount: 0,
        });
      }
    }
    transaction.changed('outbox');
    return appended.intent;
  }

  /**
   * The visible field edit and its queued patch, in one commit (P3-29).
   *
   * The same ordering key as the create — `list:<listId>` — so an edit to an item typed a
   * moment ago serialises **behind** the create that names it, and neither races an archive or
   * a delete of the list they are both on. The entity is the item, as it is for the create.
   *
   * ## It reads the row inside the transaction
   *
   * The projection is a merge onto current truth, and current truth may be a create that has
   * not been acknowledged yet or an earlier edit still in the queue. Reading from the writer is
   * what makes two quick edits to the same field land as the second value rather than as
   * whichever response returned last.
   *
   * ## No reorder rides here
   *
   * `afterItemId` is refused outright. P3-30 keeps reorder online-only in as many words — "no
   * reorder intent enters the outbox" — because a position resolved against neighbours the
   * device saw an hour ago is not the position the user asked for.
   */
  async patchItem(
    transaction: TransactionContext,
    variables: ListItemPatchVariables,
  ): Promise<OutboxIntent> {
    const items = this.requireItems();
    if (variables.input.afterItemId !== undefined) {
      throw new Error('A durable item edit cannot carry a position.');
    }
    const current = await items.getLocal(variables.itemId, transaction.database);
    if (current === undefined || current.listId !== variables.listId) {
      throw new Error('The item is no longer available locally.');
    }
    const appended = await this.outbox.append(transaction.database, {
      intentId: variables.intentId,
      mutationKey: listMutationKeys.itemPatch,
      variables,
      entityId: variables.itemId,
      orderingKey: `list:${variables.listId}`,
    });
    if (appended.kind === 'inserted') {
      await this.projectItemPatch(transaction, current, variables.input);
    }
    transaction.changed('outbox');
    return appended.intent;
  }

  /** Removes the visible row and queues the server delete in the same SQLite commit. */
  async deleteItem(
    transaction: TransactionContext,
    input: EnqueueListItemDelete,
  ): Promise<OutboxIntent> {
    const items = this.requireItems();
    const current = await items.getLocal(input.itemId, transaction.database);
    if (current === undefined || current.listId !== input.listId) {
      throw new Error('The item is no longer available locally.');
    }
    const variables: ListItemDeleteVariables = {
      ...input,
      previous: current,
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId: input.intentId,
      mutationKey: listMutationKeys.itemDelete,
      variables,
      entityId: input.itemId,
      orderingKey: `list:${input.listId}`,
    });
    if (appended.kind === 'inserted') {
      await this.outbox.createListItemDeleteUndoOffer(transaction.database, {
        originalIntentId: input.intentId,
        listId: input.listId,
        itemId: input.itemId,
        previous: current,
      });
      await this.removeItem(transaction, input.listId, input.itemId);
    }
    transaction.changed('outbox');
    return appended.intent;
  }

  /** Accepts item Undo locally, either cancelling an unsent delete or queuing its compensation. */
  async undoDeletedItem(
    transaction: TransactionContext,
    originalIntentId: string,
    inverseIntentId: string,
  ): Promise<{ readonly kind: 'cancelled' | 'queued'; readonly intent?: OutboxIntent }> {
    const offer = await this.outbox.listItemDeleteUndoOffer(
      transaction.database,
      originalIntentId,
    );
    if (offer === undefined) throw new Error('This Undo offer is no longer available.');
    const previous = savedListItem(offer.previous);
    if (previous === undefined || previous.itemId !== offer.itemId) {
      throw new Error('The saved item snapshot is invalid.');
    }
    const original = await this.outbox.get(transaction.database, offer.currentIntentId);
    if (original?.status === 'queued' && original.attempts === 0) {
      if (!(await this.outbox.cancelQueued(transaction.database, original.intentId))) {
        throw new Error('The delete started syncing before it could be cancelled.');
      }
      await this.outbox.clearListItemDeleteUndoOffer(
        transaction.database,
        originalIntentId,
      );
      await this.installCanonicalItem(transaction, previous);
      transaction.changed('outbox');
      return { kind: 'cancelled' };
    }
    if (original?.status === 'needs_attention') {
      throw new Error('The delete needs recovery before it can be undone.');
    }
    const receipt = undoOfferReceipt(offer);
    if (
      receipt === undefined &&
      original?.status !== 'in_flight' &&
      !(original?.status === 'queued' && original.attempts > 0)
    ) {
      throw new Error('The delete acknowledgement did not provide an Undo token.');
    }
    const receiptState: ListItemUndoVariables['receipt'] =
      receipt === undefined
        ? { kind: 'pending' }
        : { kind: 'ready', undoToken: receipt.undoToken };
    const variables: ListItemUndoVariables = {
      listId: offer.listId,
      itemId: offer.itemId,
      intentId: inverseIntentId,
      idempotencyKey: inverseIntentId,
      originalIntentId,
      receipt: receiptState,
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId: inverseIntentId,
      mutationKey: listMutationKeys.itemUndo,
      variables,
      entityId: offer.itemId,
      orderingKey: `list:${offer.listId}`,
      ...(original === undefined ? {} : { dependsOnIntentId: original.intentId }),
      ...(original === undefined ? {} : { compensationForIntentId: original.intentId }),
    });
    if (appended.kind === 'inserted') {
      await this.outbox.linkListItemDeleteUndoIntent(
        transaction.database,
        originalIntentId,
        inverseIntentId,
      );
      await this.installCanonicalItem(transaction, previous);
    }
    transaction.changed('outbox');
    return { kind: 'queued', intent: appended.intent };
  }

  async commitItemDeleteUndoOffer(
    transaction: TransactionContext,
    originalIntentId: string,
  ): Promise<void> {
    await this.outbox.clearListItemDeleteUndoOffer(
      transaction.database,
      originalIntentId,
      true,
    );
    transaction.changed('outbox');
  }

  async installCanonicalItem(
    transaction: TransactionContext,
    item: ListItemRow,
  ): Promise<void> {
    const items = this.requireItems();
    const current = await items.getLocal(item.itemId, transaction.database);
    await items.installAcknowledged(transaction, item);
    await this.lists.applyLocalItemDelta(transaction, item.listId, {
      itemCount: current === undefined ? 1 : 0,
      doneCount: doneCountForState(item.state) - doneCountForState(current?.state),
    });
  }

  async removeItem(
    transaction: TransactionContext,
    listId: string,
    itemId: string,
  ): Promise<void> {
    const items = this.requireItems();
    const current = await items.getLocal(itemId, transaction.database);
    await items.removeCanonical(transaction, listId, itemId);
    if (current !== undefined && current.listId === listId) {
      await this.lists.applyLocalItemDelta(transaction, listId, {
        itemCount: -1,
        doneCount: -doneCountForState(current.state),
      });
    }
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
      mutationKey: listMutationKeys.create,
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
    return this.patchSettings(transaction, list, { archived }, intentId);
  }

  /**
   * One durable List settings write and its optimistic row, in one commit (P3-25, §P3-32).
   *
   * The generalisation of what `setArchived` did for one field. Everything the settings sheet
   * and the inline rename change — `title`, the two capability flags, the default `slot` and
   * `archived` — is the same route under the same `If-Match`, so it is one intent kind and one
   * ordering key. Behaviour is **not** here: it has no place in `patchListInput` by type and
   * goes through {@link changeBehaviour}.
   *
   * ## Which changes get an Undo offer, and why the check is on the fields
   *
   * The server records an inverse for every additive settings change and none for a rename
   * (`listSettingsMutation`'s union, `interaction-contract.md` §4.1, which has no undo row for
   * renaming a list). So the offer row is created when the patch touches anything **other**
   * than the title, and a title-only patch creates none rather than creating one that would
   * wait forever for a token the response will not carry.
   */
  async patchSettings(
    transaction: TransactionContext,
    list: List,
    patch: PatchListInput,
    intentId: string,
  ): Promise<OutboxIntent> {
    const current = await this.lists.getLocal(transaction.database, list.listId);
    if (current === undefined)
      throw new Error('The list is no longer available locally.');
    const projection = localSettingsFrom(patch);
    const variables: ListPatchVariables = {
      listId: list.listId,
      intentId,
      idempotencyKey: intentId,
      input: patch,
      // The sheet's callback can outlive acknowledgement of an earlier settings write. Reading
      // inside this transaction makes the next one use the latest committed canonical version,
      // while a still-queued predecessor retains its original version and is rebased on
      // settlement.
      ifMatch: current.updatedAt,
      previous: previousSettingsFor(current, patch),
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId,
      mutationKey: listMutationKeys.patch,
      variables,
      entityId: list.listId,
      orderingKey: `list:${list.listId}`,
    });
    if (appended.kind === 'inserted') {
      await this.lists.applyLocalSettings(transaction, list.listId, projection);
      if (recordsInverse(patch)) {
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
   * One durable behaviour change and its optimistic row, in one commit (§P3-09, §P3-32).
   *
   * The **inventory extension** this task adds: a new `['list','behaviour']` mutation key, its
   * own variables shape, its own push branch and its own settlement. It is ordered behind every
   * other write to the same list by the shared `list:<listId>` key, because a migration that
   * overtook a queued rename would run its `If-Match` against a version that never existed.
   *
   * An **upgrade** — the only direction that reaches here without a `confirmation` — records the
   * Undo offer, because the server retains a dedicated compensation for it (§4.1's upgrade row).
   * A **confirmed downgrade** records none: what it removed is gone, and an offer would promise
   * a restore the server cannot make.
   */
  /**
   * Accepts settings Undo as a durable compensation, never as a reconstructed PATCH.
   * If the forward write has not left the queue yet, cancelling it is the exact inverse.
   *
   * The local row is put back from the forward intent's recorded `previous` — its projection,
   * not its inverse. The server's compensation is the opaque token and only the opaque token;
   * this is the same optimistic redraw archiving has always done, no longer pinned to one field.
   */
  async undoSettings(
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
      throw new Error('This Undo offer is no longer available.');
    }
    const original = await this.outbox.get(transaction.database, offer.currentIntentId);
    const restore = previousSettingsOf(original);
    if (original?.status === 'queued' && original.attempts === 0) {
      if (
        !(await this.outbox.cancelQueued(transaction.database, offer.currentIntentId))
      ) {
        throw new Error('The change started syncing before it could be cancelled.');
      }
      await this.outbox.clearListArchiveUndoOffer(transaction.database, originalIntentId);
      await this.lists.applyLocalSettings(transaction, listId, restore);
      transaction.changed('outbox');
      return { kind: 'cancelled' };
    }
    if (original?.status === 'needs_attention') {
      throw new Error('The change needs recovery before it can be undone.');
    }
    const receipt = undoOfferReceipt(offer);
    if (
      receipt === undefined &&
      original?.status !== 'in_flight' &&
      !(original?.status === 'queued' && original.attempts > 0)
    ) {
      throw new Error('The acknowledgement did not provide an Undo token.');
    }
    const variables: ListUndoVariables = {
      listId,
      intentId: inverseIntentId,
      idempotencyKey: inverseIntentId,
      originalIntentId,
      ...(receipt === undefined ? {} : { undoToken: receipt.undoToken }),
    };
    const appended = await this.outbox.append(transaction.database, {
      intentId: inverseIntentId,
      mutationKey: listMutationKeys.undo,
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
      await this.lists.applyLocalSettings(transaction, listId, restore);
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
      mutationKey: listMutationKeys.delete,
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
      const items = this.requireItems();
      const existing = await items.getLocal(intent.entityId, transaction.database);
      if (existing !== undefined) return intent;
      await this.createItem(
        transaction,
        parseItemCreateVariables(variables, intent.entityId),
        true,
      );
      return intent;
    }
    if (intent.mutationKey[1] === 'item-patch') {
      /*
       * The rollback restored the server's row over the edit. Re-applying it from the durable
       * payload is what a Retry means here — the same fields, onto whatever truth now is.
       */
      const parsed = parseItemPatchVariables(variables, intent.entityId);
      const items = this.requireItems();
      const current = await items.getLocal(intent.entityId, transaction.database);
      if (current === undefined || current.listId !== parsed.listId) {
        throw new Error('The item is no longer available locally.');
      }
      await this.projectItemPatch(transaction, current, parsed.input);
      return intent;
    }
    if (isListMutation(intent, 'itemDelete')) {
      const listId = Reflect.get(variables, 'listId');
      if (typeof listId !== 'string') {
        throw new Error('The saved item delete no longer names a list.');
      }
      await this.removeItem(transaction, listId, intent.entityId);
      return intent;
    }
    if (isListMutation(intent, 'itemUndo')) {
      const offer = await this.outbox.listItemDeleteUndoOffer(
        transaction.database,
        intent.intentId,
      );
      const previous = offer === undefined ? undefined : savedListItem(offer.previous);
      if (previous === undefined || previous.itemId !== intent.entityId) {
        throw new Error('The saved item Undo no longer has a valid rollback image.');
      }
      await this.installCanonicalItem(transaction, previous);
      return intent;
    }
    if (intent.mutationKey[1] === 'create') {
      /*
       * The rollback removed the row this create was showing, so the retry has to put it back
       * — from the durable payload, which carries the seed frozen at confirmation rather than
       * whatever the shipped catalogue says now.
       */
      const existing = await this.lists.getLocal(transaction.database, intent.entityId);
      if (existing !== undefined) return intent;
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
      /*
       * Both settings routes retry the same way: re-project the durable payload onto whatever
       * truth now is, and rebase its `If-Match` onto the version the rollback restored. Parsed
       * rather than read field by field, so a payload written by an older build fails here with
       * words the recovery banner can show instead of being sent as something the server will
       * reject.
       */
      const settings = localSettingsFrom(parsePersistedPatch(variables));
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
      /*
       * An Undo the user already accepted outranks the forward change it compensates: retrying
       * the original must not redraw a state they have taken back. So the projection is the
       * recorded `previous` in that case, and the forward payload in every other.
       */
      await this.lists.applyLocalSettings(
        transaction,
        intent.entityId,
        undoOffer === undefined || undoOfferInverseIntentId(undoOffer) === undefined
          ? settings
          : previousSettingsOf(intent),
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

  private async projectItemPatch(
    transaction: TransactionContext,
    current: ListItemRow,
    input: PatchListItemInput,
  ): Promise<void> {
    await this.requireItems().applyLocalPatch(transaction, current, input);
    const nextState = input.state ?? current.state;
    const doneCount = doneCountForState(nextState) - doneCountForState(current.state);
    if (doneCount !== 0) {
      await this.lists.applyLocalItemDelta(transaction, current.listId, {
        itemCount: 0,
        doneCount,
      });
    }
  }
}
