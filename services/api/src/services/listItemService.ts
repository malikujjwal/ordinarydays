import { createHash } from 'node:crypto';
import { BULK_UNDO_OFFER_SECONDS, MAX_LIST_ITEMS, UNDO_OFFER_SECONDS } from '@od/shared';
import {
  type BulkCreateListItemsInput,
  bulkCreateListItemsInputFor,
  type CreateListItemInput,
  createListItemInputFor,
  type PatchListItemInput,
  patchListItemInputFor,
} from '@od/shared/schemas';
import type {
  Activity,
  List,
  ListItem,
  ListItemActivityLink,
  ListItemPlanState,
  ReversibleItemMutation,
} from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { mintUndoToken } from '../lib/undoToken.js';
import { getActivityPartitionStrong } from '../repositories/activityRepository.js';
import { writeReceiptOnly } from '../repositories/idempotencyRepository.js';
import {
  batchGetViewerLinks,
  createListItems,
  deleteListItem,
  deleteStaleViewerLink,
  getListItem,
  getListMeta,
  type ListAccessGrant,
  ListFullError,
  type ListItemFieldPatch,
  ListItemIdUnavailableError,
  ListItemNotFoundError,
  ListMutationRetryExhaustedError,
  ListRankRepairRequiredError,
  ListReadFenceError,
  listItems as listItemsPage,
  type NewListItem,
  newItemId,
  newListOperationId,
  patchListItemFields,
  reorderListItem,
  resolveExistingItems,
  runBulkCheckedOperation,
} from '../repositories/listRepository.js';
import { ID_UNAVAILABLE } from './activityService.js';
import {
  assertActivityReadAccessFromPartition,
  assertListAccess,
  readableActivities,
} from './authz.js';
import { drainListWork, withListWorkDrain } from './listMutationService.js';
import { repairListRanks } from './listRankRepairService.js';

/**
 * ListItem CRUD and its rules (`phase-03` §P3-08, `api-contract.md` §2.7).
 *
 * Every path here goes through `assertListAccess` first — a member may do full CRUD on
 * items, a stranger gets `404` — and every rule below is decided once, here, rather than in
 * a handler where the next endpoint would re-derive it slightly differently.
 *
 * ## The two-part gates, and why there is no list of "checkable kinds"
 *
 * `checked` is meaningful only when the list is a `collection` **and** its `checkable`
 * capability is on; `location` only when it is a `collection` **and** `supportsLocation` is
 * on. Both halves are load-bearing: a `watch` list may carry a stored `checkable: true` that
 * a later behaviour change left behind, and honouring it would put a checkbox on a list
 * whose renderer has none (acceptance criterion 18). Stored values are **retained** while a
 * gate is closed, so turning a capability back on restores exactly what was there.
 *
 * Nothing here compares a `templateKey`. The gate reads the row's own behaviour and flags,
 * which is the whole difference between a capability and a kind (ADR-031).
 */

const FULL = 'List is full.';
const ITEM_NOT_FOUND = 'List item not found.';
const LIST_NOT_FOUND = 'List not found.';
const BUSY = 'This list is busy. Try again.';

/**
 * Items per bulk transaction.
 *
 * Each item costs three actions — the ranked row, its identity locator and its tombstone
 * check — and the transaction also carries the list-deletion gate, the META counter/version
 * advance and the idempotency receipt. `(100 − 3) / 3` is 32; the sequence is chunked at
 * that so a 500-item bulk is a resumable series rather than a request that cannot be built.
 */
const BULK_CHUNK = 32;

function itemNotFound(): AppError {
  return new AppError('not_found', ITEM_NOT_FOUND);
}

/**
 * Turns the repository's untyped failure signals into contract errors.
 *
 * `ListItemNotFoundError`, `ListItemIdUnavailableError` and `ListMutationRetryExhaustedError`
 * are plain `Error`s by design — the repository stores rather than decides — so without this
 * they would each surface as a `500` that tells the caller nothing.
 */
function asAppError(error: unknown): unknown {
  if (error instanceof ListFullError) return listFull();
  if (error instanceof ListItemNotFoundError) return itemNotFound();
  if (error instanceof ListItemIdUnavailableError) {
    return new AppError('conflict', ID_UNAVAILABLE);
  }
  if (error instanceof ListMutationRetryExhaustedError) {
    return new AppError('internal', BUSY, undefined, 1);
  }
  return error;
}

async function mapped<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw asAppError(error);
  }
}

/**
 * The list every item mutation is about, with any standing work drained first.
 *
 * `api-contract.md` §2.7 requires every item mutation to attempt a bounded drain and
 * otherwise answer the retryable `503`, and doing it here rather than per endpoint means one
 * place enforces it for create, bulk, patch and delete. It happens **before** the write is
 * attempted, so a drained-and-retried mutation cannot have half-applied: the repository's
 * gate conditions are still the enforcement, and this only saves the client a round trip when
 * the work was already finishable.
 */
async function loadList(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  now: string,
): Promise<List> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  if (list.rankRepairId === undefined && list.behaviourMigrationId === undefined) {
    return list;
  }
  // The same retryable `503` a fenced read gives: the marker is still standing, and
  // `api-contract.md` §2.7 gives one answer for that whoever asked (P3-09).
  if (!(await drainListWork(userId, listId, access, now))) throw new ListReadFenceError();
  const drained = await getListMeta(userId, listId, access);
  if (drained === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  return drained;
}

function refuse(path: string, message: string): never {
  throw new AppError('validation_failed', message, [{ path, message }]);
}

/** `collection` **and** the flag. Both halves, on every write path. */
function assertCheckedAllowed(list: List): void {
  if (list.behaviour !== 'collection' || !list.capabilities.checkable) {
    refuse('checked', 'This list does not have checkboxes.');
  }
}

function assertLocationAllowed(list: List): void {
  if (list.behaviour !== 'collection' || !list.capabilities.supportsLocation) {
    refuse('location', 'This list does not have places on its items.');
  }
}

/**
 * `details` is accepted only when the behaviour has a details shape and the discriminant
 * matches it. The discriminant half is the shared `checkDetailsMatchBehaviour` rule applied
 * by the route's `*For(behaviour)` schema; this is the half that schema cannot express,
 * because a `collection` has no arm to match against at all.
 *
 * A `null` is refused on every behaviour: a `collection` has nothing to clear, and on
 * `watch` or `meals` removing the typed fields is a **destructive behaviour change** that
 * only P3-09's confirmed, gated migration may make — not a field clear on one item.
 */
function assertDetailsAllowed(list: List, details: unknown): void {
  if (list.behaviour === 'collection') {
    refuse('details', 'Items on this list do not carry those fields.');
  }
  if (details === null) {
    refuse('details', 'Those fields are removed by changing the list, not one item.');
  }
}

/**
 * The gates take `unknown` for the two structured fields on purpose: presence is the whole
 * question here, and the *shape* is already settled by the route's `*For(behaviour)` schema.
 * Typing them tighter would only re-litigate Zod's `T | undefined` against the domain's
 * `T?` at a boundary that does not read either value.
 *
 * **Presence, not truthiness.** A `null` is a request to clear the field, and clearing is
 * exactly as gated as setting: `PATCH { location: null }` on a list whose `supportsLocation`
 * is off would otherwise slip past and delete the address the capability toggle promised to
 * retain (`plans-and-lists.md` §5.5 — turning a capability off hides values, never destroys
 * them).
 */
function assertWritableFields(
  list: List,
  fields: {
    readonly checked?: boolean | undefined;
    readonly location?: unknown;
    readonly details?: unknown;
  },
): void {
  if (fields.checked !== undefined) assertCheckedAllowed(list);
  if ('location' in fields && fields.location !== undefined) assertLocationAllowed(list);
  if ('details' in fields && fields.details !== undefined) {
    assertDetailsAllowed(list, fields.details);
  }
}

/**
 * Applies the shared `details.behaviour === list.behaviour` rule with the loaded List.
 *
 * The route's `zValidator` cannot: an item body does not carry its list's behaviour, and the
 * route has no database. So the strict shape is settled at the edge and this re-parses the
 * same body against the behaviour-bound schema, which raises the issue at the exact
 * `details.behaviour` path both the single and bulk forms use (P3-01).
 */
function assertMatchesBehaviour<T>(
  schema: { parse: (value: unknown) => T },
  body: unknown,
) {
  schema.parse(body);
}

/** The one place the product's `List is full.` copy lives. */
function listFull(): AppError {
  return new AppError('validation_failed', FULL, [{ path: 'items', message: FULL }]);
}

/**
 * The cheap precheck, which refuses an obviously-full list before any write is attempted.
 *
 * It is **not** the enforcement: two creates against a 499-item list both pass it. The cap
 * is a condition on the create transaction's META update, and a failure there comes back as
 * `ListFullError` and through {@link asAppError} to the same copy.
 */
function assertCapacity(list: List, adding: number): void {
  if (adding > 0 && list.itemCount + adding > MAX_LIST_ITEMS) throw listFull();
}

/**
 * The validated body as a domain item.
 *
 * The cast is the same one every parse boundary in this codebase makes: Zod models an
 * optional key as `value | undefined` while `exactOptionalPropertyTypes` models absence, and
 * the two disagree on nested optionals like `location.address` that no conditional spread at
 * this level can reconcile. The keys are already spread conditionally, so nothing carries an
 * explicit `undefined` into storage.
 */
function toNewItem(input: CreateListItemInput): NewListItem {
  return {
    itemId: input.itemId ?? newItemId(),
    title: input.title,
    checked: false,
    ...(input.note === undefined ? {} : { note: input.note }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.details === undefined ? {} : { details: input.details }),
  } as NewListItem;
}

/**
 * Allocates ranks and writes, repairing once if the gap cannot be subdivided.
 *
 * The repository refuses to invent a rank from an equal-rank run or an exhausted gap; this
 * is the one place that answers that refusal, and it repairs and retries **once**. If the
 * bounded repair has not finished, the caller gets the retryable `503` rather than a second
 * repair attempt stacked on the first.
 */
async function writeItemsRepairingOnce(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  items: readonly NewListItem[],
  options: {
    readonly now: string;
    readonly afterItemId?: string | null;
    readonly receiptFor?: (items: ListItem[]) => IdempotencyReceipt;
  },
): Promise<ListItem[]> {
  try {
    return await createListItems(userId, listId, access, items, options);
  } catch (error) {
    if (!(error instanceof ListRankRepairRequiredError)) throw asAppError(error);
    const repaired = await repairListRanks(userId, listId, access, options.now);
    if (!repaired) throw new AppError('internal', BUSY, undefined, 1);
    return mapped(() => createListItems(userId, listId, access, items, options));
  }
}

export interface CreateListItemResult {
  readonly item: ListItem;
}

/** `POST /v1/lists/:id/items`. */
export async function createItem(
  userId: string,
  listId: string,
  input: CreateListItemInput,
  now: string,
  receiptFor?: (item: ListItem) => IdempotencyReceipt,
): Promise<ListItem> {
  const access = await assertListAccess(userId, listId, 'write');
  const list = await loadList(userId, listId, access.index, now);
  assertMatchesBehaviour(createListItemInputFor(list.behaviour), input);
  assertWritableFields(list, input);
  assertCapacity(list, 1);

  // Built **once**: `toNewItem` mints a server id when the client sent none, so calling it
  // again for the receipt would store — and replay for 24 hours — a response naming an item
  // that was never written.
  const item = toNewItem(input);
  const created = await writeItemsRepairingOnce(userId, listId, access.index, [item], {
    now,
    ...(input.afterItemId === undefined ? {} : { afterItemId: input.afterItemId }),
    ...(receiptFor === undefined
      ? {}
      : {
          receiptFor: (items: ListItem[]) => {
            const written = items[0];
            if (written === undefined) {
              throw new AppError('internal', 'An unexpected error occurred.');
            }
            return receiptFor(written);
          },
        }),
  });
  const written = created[0];
  if (written === undefined) {
    throw new AppError('internal', 'An unexpected error occurred.');
  }
  return written;
}

/**
 * `POST /v1/lists/:id/items/bulk`.
 *
 * One transaction when the whole batch fits, a resumable chunked sequence when it does not.
 * Each chunk chains off the previous chunk's last item, so the sent order survives a batch
 * that spans several transactions.
 *
 * ## Idempotency, twice over
 *
 * Under the `Idempotency-Key` the middleware replays the stored response and nothing runs.
 * **After that receipt expires**, replay protection falls to the stable per-item ids: each
 * chunk first resolves which of its ids already exist and writes only the remainder, so a
 * replay of a partially committed batch completes it instead of duplicating it. Ids the
 * client did not mint get server-minted ones and have no such guarantee, which is the
 * documented trade for staying online-compatible.
 */
export async function createItemsBulk(
  userId: string,
  listId: string,
  input: BulkCreateListItemsInput,
  now: string,
  receiptFor?: (items: ListItem[]) => IdempotencyReceipt,
): Promise<ListItem[]> {
  const access = await assertListAccess(userId, listId, 'write');
  const list = await loadList(userId, listId, access.index, now);
  assertMatchesBehaviour(bulkCreateListItemsInputFor(list.behaviour), input);
  for (const member of input.items) assertWritableFields(list, member);

  /**
   * The batch is **one ordered sequence from one anchor**, because its ranks come from a
   * single `rankVersion` read and advance that version once per chunk. Honouring a
   * per-member `afterItemId` would mean an allocation each, which is the fan-out the
   * sequence exists to avoid — so the first member may anchor the run and a later one
   * carrying its own position is refused rather than silently ignored.
   */
  const anchor = input.items[0]?.afterItemId;
  const misplaced = input.items.findIndex(
    (member, index) => index > 0 && member.afterItemId !== undefined,
  );
  if (misplaced > 0) {
    refuse(
      `items.${misplaced}.afterItemId`,
      'A bulk insert takes one position, on its first item.',
    );
  }

  const planned = input.items.map(toNewItem);

  /**
   * **Resolve first, then measure.** Capacity is a question about the rows this call would
   * *add*, not about the array it was handed: a 40-item batch that committed its first
   * chunk and crashed must be able to finish, and measuring the whole array against a list
   * those 32 rows already grew would reject the retry that is supposed to complete it.
   */
  // Only ids the client actually minted can already exist; a server-minted ULID is new by
  // construction, so the common online path pays for no extra read.
  const clientIds = planned.flatMap((item, index) =>
    input.items[index]?.itemId === undefined ? [] : [item.itemId],
  );
  const committed = await resolveExistingItems(userId, listId, access.index, clientIds);
  const missing = planned.filter((item) => !committed.has(item.itemId));
  assertCapacity(list, missing.length);

  const positionOf = new Map(planned.map((item, index) => [item.itemId, index]));
  const chunks: NewListItem[][] = [];
  for (let from = 0; from < missing.length; from += BULK_CHUNK) {
    chunks.push(missing.slice(from, from + BULK_CHUNK));
  }

  const created = new Map<string, ListItem>();

  /** The whole batch as server truth, in the order it was sent. */
  const canonical = (): ListItem[] =>
    planned.flatMap((item) => {
      const row = created.get(item.itemId) ?? committed.get(item.itemId);
      return row === undefined ? [] : [row];
    });

  if (chunks.length === 0 && receiptFor !== undefined) {
    // Every id was already committed: no domain rows to write, but the operation still has
    // to record its receipt or the next replay re-resolves the whole batch.
    await writeReceiptOnly(receiptFor(canonical()));
  }

  for (const [index, chunk] of chunks.entries()) {
    const isFinal = index === chunks.length - 1;
    /**
     * A chunk hangs off **the planned item immediately before its first**, not off the
     * previous chunk's last — they differ whenever an earlier attempt already committed
     * something in between. Everything ahead of this chunk is committed by now, either by a
     * previous attempt or by an earlier iteration, so that predecessor is always resolvable.
     */
    const at = positionOf.get(chunk[0]?.itemId ?? '') ?? 0;
    const predecessor = at > 0 ? planned[at - 1]?.itemId : undefined;
    const after = predecessor ?? anchor;

    const written = await writeItemsRepairingOnce(userId, listId, access.index, chunk, {
      now,
      ...(after === undefined ? {} : { afterItemId: after }),
      // The receipt joins the **last** chunk, so a crash part-way through records no
      // successful response and the replay resumes rather than replaying a lie. It is
      // built from server truth for every requested id, ranks included.
      ...(isFinal && receiptFor !== undefined
        ? {
            receiptFor: (items: ListItem[]) => {
              for (const item of items) created.set(item.itemId, item);
              return receiptFor(canonical());
            },
          }
        : {}),
    });
    for (const item of written) created.set(item.itemId, item);
  }

  return canonical();
}

/** `PATCH /v1/lists/:id/items/:itemId`. */
export async function patchItem(
  userId: string,
  listId: string,
  itemId: string,
  input: PatchListItemInput,
  now: string,
): Promise<ListItem> {
  const access = await assertListAccess(userId, listId, 'write');
  const list = await loadList(userId, listId, access.index, now);
  assertMatchesBehaviour(patchListItemInputFor(list.behaviour), input);
  assertWritableFields(list, input);

  const reordering = 'afterItemId' in input && input.afterItemId !== undefined;
  const fields = (['title', 'checked', 'note', 'location', 'details'] as const).filter(
    (field) => field in input,
  );
  if (!reordering && fields.length === 0) {
    refuse('title', 'This update changes nothing.');
  }

  // Same parse-boundary cast as `toNewItem`; `null` here means "clear this field" and is
  // carried through deliberately, so it must survive rather than be spread away.
  const patch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.checked === undefined ? {} : { checked: input.checked }),
    ...('note' in input ? { note: input.note ?? null } : {}),
    ...('location' in input ? { location: input.location ?? null } : {}),
    ...('details' in input ? { details: input.details ?? null } : {}),
  } as ListItemFieldPatch;

  /**
   * A position and ordinary fields may arrive together (`api-contract.md` §2.7 lists them
   * in one body), and they must land together: a client that dragged a row and renamed it
   * in one request must not end up with the rename applied and the move lost. The reorder
   * already re-puts the whole row at its new key, so the patch folds into that put and the
   * transaction is still the same four domain actions.
   */
  if (reordering) {
    return moveItem(
      userId,
      listId,
      access.index,
      itemId,
      input.afterItemId ?? null,
      now,
      fields.length === 0 ? undefined : patch,
    );
  }

  return mapped(() =>
    patchListItemFields(userId, listId, access.index, itemId, patch, now),
  );
}

/** The four-action reorder, repairing once if the target gap cannot be subdivided. */
async function moveItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  afterItemId: string | null,
  now: string,
  patch?: ListItemFieldPatch,
): Promise<ListItem> {
  const options = { now, afterItemId, ...(patch === undefined ? {} : { patch }) };
  try {
    return await reorderListItem(userId, listId, access, itemId, options);
  } catch (error) {
    if (!(error instanceof ListRankRepairRequiredError)) throw asAppError(error);
    const repaired = await repairListRanks(userId, listId, access, now);
    if (!repaired) throw new AppError('internal', BUSY, undefined, 1);
    return mapped(() => reorderListItem(userId, listId, access, itemId, options));
  }
}

/**
 * `DELETE /v1/lists/:id/items/:itemId`.
 *
 * The repository writes the ranked row's removal, its locator, the exact deletion snapshot
 * — including the current viewer links and Activity provenance, which stay empty until
 * P3-13 writes the first one but whose shape the snapshot already carries — and a
 * single-use `UNDO#` record. **Restoration is P3-10's endpoint**, not this one.
 *
 * The token is minted here and only its **hash** is stored, so a leaked work record cannot
 * be replayed into an Undo, and the client hands the token back rather than sending deleted
 * row contents as authority.
 */
export async function removeItem(
  userId: string,
  listId: string,
  itemId: string,
  now: string,
  receiptFor?: (result: ReversibleItemMutation) => IdempotencyReceipt,
): Promise<ReversibleItemMutation> {
  const access = await assertListAccess(userId, listId, 'write');
  await loadList(userId, listId, access.index, now);

  const operationId = newListOperationId();
  /**
   * The token **addresses** the operation it belongs to (P3-10, `lib/undoToken.ts`): the undo
   * route receives a token and nothing else, and this table has one index that is not worth
   * spending on the few operations anybody ever undoes.
   */
  const { token: undoToken, tokenHash } = mintUndoToken(operationId);
  const result: ReversibleItemMutation = {
    affectedCount: 1,
    undoToken,
    undoExpiresAt: new Date(Date.parse(now) + UNDO_OFFER_SECONDS * 1000).toISOString(),
  };

  await mapped(() =>
    deleteListItem(userId, listId, access.index, itemId, {
      operationId,
      tokenHash,
      undoExpiresAt: result.undoExpiresAt,
      now,
      ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(result) }),
    }),
  );

  return result;
}

const NOT_CHECKABLE =
  'This list does not have checkboxes, so there is nothing to clear or uncheck.';

/**
 * The two-part gate, applied to the **operations** as well as to the fields (criterion 18).
 *
 * Both halves matter here for the same reason they matter on a checkbox write: a `watch` list
 * may still carry a stored `checkable: true` that a behaviour change left behind, and its
 * items may still carry `checked` values that behaviour change retained. Offering to clear
 * them would delete rows on the strength of a flag whose renderer draws no checkbox — the
 * hidden retained state is exactly what these endpoints must not reach.
 */
function assertBulkCheckedAllowed(list: List): void {
  if (list.behaviour !== 'collection' || !list.capabilities.checkable) {
    refuse('checked', NOT_CHECKABLE);
  }
}

/**
 * The operation's stable identity: this caller's `Idempotency-Key`, hashed (P3-10).
 *
 * A bulk action at the item cap is twenty-odd transactions, and the `UNDO#` record naming
 * every id lands in the first of them. If a retry minted a **fresh** operation it would delete
 * whatever was left under a second one and strand the first chunks' rows behind a token nobody
 * ever received. Deriving the id from the key is what makes the retry finish the operation it
 * already started, and answer with the token that operation already promised. The same
 * reasoning, and the same derivation, as the behaviour migration's.
 */
function bulkOperationId(userId: string, idempotencyKey: string): string {
  return `blk_${createHash('sha256')
    .update(`${userId}:${idempotencyKey}`)
    .digest('base64url')
    .slice(0, 32)}`;
}

/**
 * Runs one bulk checked action, resuming this key's own outstanding one.
 *
 * The plan — the token, its 10-second window and the receipt — is made **once**, when the
 * operation is new, and recorded. A resume reads it back rather than deciding again, so every
 * attempt answers with the same token for the same operation.
 */
async function runBulkChecked(
  userId: string,
  listId: string,
  kind: 'clear_checked' | 'uncheck_all',
  idempotencyKey: string,
  now: string,
  receiptFor?: (result: ReversibleItemMutation) => IdempotencyReceipt,
): Promise<ReversibleItemMutation> {
  const access = await assertListAccess(userId, listId, 'write');
  const list = await loadList(userId, listId, access.index, now);
  assertBulkCheckedAllowed(list);

  const operationId = bulkOperationId(userId, idempotencyKey);
  const result = await mapped(() =>
    runBulkCheckedOperation(userId, listId, access.index, {
      operationId,
      kind,
      now,
      plan: (itemIds) => {
        const { token, tokenHash } = mintUndoToken(operationId);
        const undoExpiresAt = new Date(
          Date.parse(now) + BULK_UNDO_OFFER_SECONDS * 1000,
        ).toISOString();
        return {
          undoToken: token,
          tokenHash,
          undoExpiresAt,
          ...(receiptFor === undefined
            ? {}
            : {
                receipt: receiptFor({
                  affectedCount: itemIds.length,
                  undoToken: token,
                  undoExpiresAt,
                }),
              }),
        };
      },
    }),
  );

  return {
    affectedCount: result.affectedCount,
    undoToken: result.undoToken,
    undoExpiresAt: result.undoExpiresAt,
  };
}

/**
 * `POST /v1/lists/:id/clear-checked` — the end of a shopping trip.
 *
 * **No confirmation dialog**, by the decision recorded in §P3-10 and `00-open-decisions.md`
 * item 33: the count is in the button the user tapped, they ticked each of those rows one at
 * a time, and the 10-second undo window is the safety net. This is the single deliberate
 * exception to `interaction-contract.md` §1a.1, and the reason the response carries a token
 * rather than the endpoint carrying a precondition.
 */
export async function clearCheckedItems(
  userId: string,
  listId: string,
  idempotencyKey: string,
  now: string,
  receiptFor?: (result: ReversibleItemMutation) => IdempotencyReceipt,
): Promise<ReversibleItemMutation> {
  return runBulkChecked(userId, listId, 'clear_checked', idempotencyKey, now, receiptFor);
}

/**
 * `POST /v1/lists/:id/uncheck-all` — the start of the next trip.
 *
 * Not destructive, so no dialog is even in question; it still gets the canonical 10-second
 * toast, because `interaction-contract.md` §4 gives every bulk reversible action one. The
 * operation records **exactly the ids it changed**, so compensation re-checks those and not
 * whatever happens to be unchecked when it arrives.
 */
export async function uncheckAllItems(
  userId: string,
  listId: string,
  idempotencyKey: string,
  now: string,
  receiptFor?: (result: ReversibleItemMutation) => IdempotencyReceipt,
): Promise<ReversibleItemMutation> {
  return runBulkChecked(userId, listId, 'uncheck_all', idempotencyKey, now, receiptFor);
}

/** One joined row: the item, the caller's pointer, and the Plan that pointer resolved to. */
export interface HydratedListItem {
  readonly item: ListItem;
  readonly viewerLink?: ListItemActivityLink;
  readonly viewerPlan?: ListItemPlanState;
}

export interface ListItemsProjection {
  readonly items: HydratedListItem[];
  readonly nextCursor?: string;
}

/**
 * Joins the caller's own viewer-link rows onto a page of items, keeping only links whose
 * Activity this caller may still read.
 *
 * The filter to the caller happens in the repository's keyed batch read, **before** any
 * Activity is looked up; ordinary Activity authorisation then runs, and a stale pointer is
 * omitted rather than serialised as a dead link (`api-contract.md` §3, ADR-034). Shared by
 * list detail (P3-05) and the item page, so there is one implementation of a rule the
 * security model rests on.
 *
 * ## Omitted, then removed (P3-14)
 *
 * `api-contract.md` §3 says a stale pointer is "omitted and queued for cleanup". There is no
 * queue in this phase, so the cleanup is a **best-effort conditional delete after the read**
 * — the response is already decided by the time it runs, and it cannot change what the caller
 * sees. Without it, a pointer at a deleted Plan is re-read and re-rejected on every single
 * list open, forever.
 *
 * Best-effort literally: a failure is swallowed, because a pointer that outlives one attempt
 * is a row nobody can see and the next read will try again. It is awaited rather than left
 * floating so a failing delete cannot surface as an unhandled rejection in an unrelated
 * request (`coding-standards.md` §6.1), and it only runs when something was actually stale,
 * so the ordinary read pays nothing.
 *
 * ## Why the deletion re-checks, and the read does not
 *
 * The projection's access check is an ordinary eventually consistent read, and that is fine
 * for **omitting**: a Plan created moments ago whose Activity has not reached the replica
 * yet loses its state line for one read and gets it back on the next. Omission is
 * self-healing.
 *
 * Deletion is not. Classifying a pointer stale from a lagging replica and then removing it
 * would permanently strand a Plan that exists and is readable — the Activity survives, but
 * nothing points at it and the user cannot navigate back. So the destructive step re-checks
 * **strongly** first, and only removes a pointer whose Activity is still absent or still
 * unreadable when read from the leader. §P3-14 permits cleanup for a deleted or inaccessible
 * Plan; a replica that has not caught up is neither.
 *
 * The re-check runs only for pointers that already looked stale, which is rare, so the
 * ordinary read still pays nothing for it.
 */
export async function hydrateViewerLinks(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  items: readonly ListItem[],
): Promise<HydratedListItem[]> {
  const links = await batchGetViewerLinks(
    userId,
    listId,
    access,
    items.map((item) => item.itemId),
  );
  /**
   * One batched authorisation for the whole page, not one per link.
   *
   * The ids come from rows the repository already filtered to this caller, so no other
   * viewer's Activity is named here — the caller-scoping happens **before** any Activity is
   * loaded, which is what `security-privacy.md` row 15a rests on and is easy to get backwards
   * when a loop becomes a batch.
   *
   * A link absent from the result is stale for one of the two reasons the access rule
   * deliberately cannot tell apart: the Activity is gone, or it is not this caller's to read.
   */
  const authorised = await readableActivities(
    userId,
    links.map((entry) => entry.activityId),
  );

  const readable = new Map<string, { link: ListItemActivityLink; plan: Activity }>();
  const stale: ListItemActivityLink[] = [];
  for (const link of links) {
    const plan = authorised.get(link.activityId);
    if (plan !== undefined) {
      readable.set(link.itemId, { link, plan });
      continue;
    }
    stale.push(link);
  }

  const projection = items.map((item) => {
    const joined = readable.get(item.itemId);
    if (joined === undefined) return { item };
    /**
     * The pointer and the Plan it resolved to travel together. The batch already holds the
     * Activity — this is what it was read for — so the row can say whether the Plan is
     * scheduled, unscheduled or done rather than only that one exists (P3-34).
     */
    return { item, viewerLink: joined.link, viewerPlan: toPlanState(joined.plan) };
  });

  await removeStaleViewerLinks(listId, userId, stale);
  return projection;
}

/**
 * The four fields a list row can say about a Plan, and no more (P3-15, P3-34).
 *
 * Trimmed here rather than at the handler because the trim is a **contract** decision, not a
 * serialisation one: what a list row may reveal about a caller's private Plan is the same
 * question wherever the projection is consumed, and two call sites trimming independently is
 * how one of them eventually ships a field nobody meant to.
 */
function toPlanState(plan: Activity): ListItemPlanState {
  return {
    activityId: plan.activityId,
    type: plan.type as ListItemPlanState['type'],
    status: plan.status,
    ...(plan.schedule === undefined ? {} : { schedule: plan.schedule }),
  };
}

/** Best-effort, and silent: see {@link hydrateViewerLinks}. */
async function removeStaleViewerLinks(
  listId: string,
  userId: string,
  stale: readonly ListItemActivityLink[],
): Promise<void> {
  for (const link of stale) {
    try {
      if (await stillUnreadable(userId, link.activityId)) {
        await deleteStaleViewerLink(listId, userId, link.itemId, link);
      }
    } catch {
      /**
       * Swallowed on purpose, including the condition failure that means the pointer was
       * rewritten between the read and this delete — that row is live and must survive.
       * Nothing here can fail the read it belongs to.
       */
    }
  }
}

/**
 * The strong second opinion, taken from the leader rather than a replica.
 *
 * `true` only when the Activity is genuinely gone or genuinely not this caller's to read.
 * A `not_found` from the first, eventually consistent check is a suspicion; this is the
 * confirmation, and nothing is deleted without it.
 */
async function stillUnreadable(userId: string, activityId: string): Promise<boolean> {
  try {
    await assertActivityReadAccessFromPartition(
      userId,
      await getActivityPartitionStrong(activityId),
    );
    return false;
  } catch (error) {
    if (error instanceof AppError && error.code === 'not_found') return true;
    throw error;
  }
}

/** `GET /v1/lists/:id/items?cursor=` — pattern 8's fenced page, with the caller's links. */
export async function listItemsFor(
  userId: string,
  listId: string,
  cursor: string | undefined,
): Promise<ListItemsProjection> {
  const access = await assertListAccess(userId, listId, 'read');

  return withListWorkDrain(userId, listId, access.index, async () => {
    const page = await listItemsPage(userId, listId, access.index, cursor);
    if (page === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
    return {
      items: await hydrateViewerLinks(userId, listId, access.index, page.items),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  });
}

/**
 * `GET /v1/lists/:id/items/:itemId` — the authoritative exact read.
 *
 * This is what durable creation reconciles a lost response against: `200` means the write
 * committed and the server representation wins, `404` means it did not and the client parks
 * the intent for explicit Retry or Discard (ADR-055). A tombstoned id is `404` for the same
 * reason a missing one is — the locator is gone either way, and the two must be
 * indistinguishable so a deleted item cannot be told apart from one that never existed.
 */
export async function getItemById(
  userId: string,
  listId: string,
  itemId: string,
): Promise<ListItem> {
  const access = await assertListAccess(userId, listId, 'read');

  return withListWorkDrain(userId, listId, access.index, async () => {
    const item = await getListItem(userId, listId, access.index, itemId);
    if (item === undefined) throw itemNotFound();
    return item;
  });
}
