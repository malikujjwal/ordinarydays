import { createHash, randomBytes } from 'node:crypto';
import { MAX_LIST_ITEMS } from '@od/shared';
import {
  type BulkCreateListItemsInput,
  bulkCreateListItemsInputFor,
  type CreateListItemInput,
  createListItemInputFor,
  type PatchListItemInput,
  patchListItemInputFor,
} from '@od/shared/schemas';
import type {
  List,
  ListItem,
  ListItemActivityLink,
  ListItemDetails,
  ReversibleItemMutation,
} from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import { writeReceiptOnly } from '../repositories/idempotencyRepository.js';
import {
  batchGetViewerLinks,
  createListItems,
  deleteListItem,
  getListItem,
  getListMeta,
  type ListAccessGrant,
  type ListItemFieldPatch,
  ListItemIdUnavailableError,
  ListItemNotFoundError,
  ListMutationRetryExhaustedError,
  ListNotFoundError,
  ListRankRepairRequiredError,
  listItems as listItemsPage,
  type NewListItem,
  newItemId,
  newListOperationId,
  patchListItemFields,
  reorderListItem,
  resolveExistingItemIds,
} from '../repositories/listRepository.js';
import { ID_UNAVAILABLE } from './activityService.js';
import { assertActivityAccess, assertListAccess } from './authz.js';
import { repairListRanks, withRepairDrain } from './listRankRepairService.js';

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

/** The UI's offer window for a single item delete (`interaction-contract.md` §4). */
const UNDO_OFFER_SECONDS = 6;

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

async function loadList(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<List> {
  const list = await getListMeta(userId, listId, access);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  return list;
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
 */
function assertDetailsAllowed(list: List, details: unknown): void {
  if (details == null) return;
  if (list.behaviour === 'collection') {
    refuse('details', 'Items on this list do not carry those fields.');
  }
}

/**
 * The gates take `unknown` for the two structured fields on purpose: presence is the whole
 * question here, and the *shape* is already settled by the route's `*For(behaviour)` schema.
 * Typing them tighter would only re-litigate Zod's `T | undefined` against the domain's
 * `T?` at a boundary that does not read either value.
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
  if (fields.location != null) assertLocationAllowed(list);
  assertDetailsAllowed(list, fields.details);
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

function assertCapacity(list: List, adding: number): void {
  if (list.itemCount + adding > MAX_LIST_ITEMS) {
    throw new AppError('validation_failed', FULL, [{ path: 'items', message: FULL }]);
  }
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
  const list = await loadList(userId, listId, access.index);
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
  const list = await loadList(userId, listId, access.index);
  assertMatchesBehaviour(bulkCreateListItemsInputFor(list.behaviour), input);
  for (const member of input.items) assertWritableFields(list, member);
  assertCapacity(list, input.items.length);

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
  const chunks: NewListItem[][] = [];
  for (let from = 0; from < planned.length; from += BULK_CHUNK) {
    chunks.push(planned.slice(from, from + BULK_CHUNK));
  }

  const written: ListItem[] = [];
  // Where the next chunk hangs off: the caller's anchor first, then the last id actually
  // committed, so the sent order survives a batch that spans several transactions — and
  // survives a replay that skipped a chunk it had already written.
  let after: string | null | undefined = anchor;

  for (const [index, chunk] of chunks.entries()) {
    const existing = await resolveExistingItemIds(
      userId,
      listId,
      access.index,
      chunk.map((item) => item.itemId),
    );
    const remaining = chunk.filter((item) => !existing.has(item.itemId));
    const isFinal = index === chunks.length - 1;

    if (remaining.length > 0) {
      const created = await writeItemsRepairingOnce(
        userId,
        listId,
        access.index,
        remaining,
        {
          now,
          ...(after === undefined ? {} : { afterItemId: after }),
          // The receipt joins the **last** chunk, so a crash part-way through records no
          // successful response and the replay resumes rather than replaying a lie. It is
          // built from every item this call actually wrote, ranks included.
          ...(isFinal && receiptFor !== undefined
            ? { receiptFor: (items: ListItem[]) => receiptFor([...written, ...items]) }
            : {}),
        },
      );
      written.push(...created);
    } else if (isFinal && receiptFor !== undefined) {
      // A replay that found every id already committed still has to record its receipt, or
      // the next replay would re-resolve the whole batch.
      await writeReceiptOnly(receiptFor(written));
    }

    after = chunk.at(-1)?.itemId ?? after;
  }

  return written;
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
  const list = await loadList(userId, listId, access.index);
  assertMatchesBehaviour(patchListItemInputFor(list.behaviour), input);
  assertWritableFields(list, input);

  const reordering = 'afterItemId' in input && input.afterItemId !== undefined;
  const fields = (['title', 'checked', 'note', 'location', 'details'] as const).filter(
    (field) => field in input,
  );

  if (reordering) {
    /**
     * A reorder and a field edit are two different transactions — four domain actions
     * against the ranked row, its locator and `META.rankVersion`, versus a conditional
     * update of supplied fields. Applying both would either break criterion 16's exact
     * four-action shape or leave a half-applied `PATCH` when the second failed, so a body
     * that mixes them is refused and the client sends two requests.
     */
    if (fields.length > 0) {
      refuse(
        'afterItemId',
        'Reorder an item in its own request, separately from editing its fields.',
      );
    }
    return moveItem(userId, listId, access.index, itemId, input.afterItemId ?? null, now);
  }

  if (fields.length === 0) refuse('title', 'This update changes nothing.');

  // Same parse-boundary cast as `toNewItem`; `null` here means "clear this field" and is
  // carried through deliberately, so it must survive rather than be spread away.
  const patch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.checked === undefined ? {} : { checked: input.checked }),
    ...('note' in input ? { note: input.note ?? null } : {}),
    ...('location' in input ? { location: input.location ?? null } : {}),
    ...('details' in input ? { details: input.details ?? null } : {}),
  } as ListItemFieldPatch;

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
): Promise<ListItem> {
  try {
    return await reorderListItem(userId, listId, access, itemId, { now, afterItemId });
  } catch (error) {
    if (!(error instanceof ListRankRepairRequiredError)) throw asAppError(error);
    const repaired = await repairListRanks(userId, listId, access, now);
    if (!repaired) throw new AppError('internal', BUSY, undefined, 1);
    return mapped(() =>
      reorderListItem(userId, listId, access, itemId, { now, afterItemId }),
    );
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
  await loadList(userId, listId, access.index);

  const undoToken = randomBytes(32).toString('base64url');
  const result: ReversibleItemMutation = {
    affectedCount: 1,
    undoToken,
    undoExpiresAt: new Date(Date.parse(now) + UNDO_OFFER_SECONDS * 1000).toISOString(),
  };

  await mapped(() =>
    deleteListItem(userId, listId, access.index, itemId, {
      operationId: newListOperationId(),
      tokenHash: createHash('sha256').update(undoToken).digest('base64url'),
      undoExpiresAt: result.undoExpiresAt,
      now,
      ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(result) }),
    }),
  );

  return result;
}

export interface ListItemsProjection {
  readonly items: { item: ListItem; viewerLink?: ListItemActivityLink }[];
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
 */
export async function hydrateViewerLinks(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  items: readonly ListItem[],
): Promise<{ item: ListItem; viewerLink?: ListItemActivityLink }[]> {
  const links = await batchGetViewerLinks(
    userId,
    listId,
    access,
    items.map((item) => item.itemId),
  );
  const readable = new Map<string, ListItemActivityLink>();
  for (const link of links) {
    try {
      await assertActivityAccess(userId, link.activityId, 'read');
      readable.set(link.itemId, link);
    } catch (error) {
      if (error instanceof AppError && error.code === 'not_found') continue;
      throw error;
    }
  }
  return items.map((item) => {
    const viewerLink = readable.get(item.itemId);
    return { item, ...(viewerLink === undefined ? {} : { viewerLink }) };
  });
}

/** `GET /v1/lists/:id/items?cursor=` — pattern 8's fenced page, with the caller's links. */
export async function listItemsFor(
  userId: string,
  listId: string,
  cursor: string | undefined,
): Promise<ListItemsProjection> {
  const access = await assertListAccess(userId, listId, 'read');

  return withRepairDrain(userId, listId, access.index, async () => {
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

  return withRepairDrain(userId, listId, access.index, async () => {
    const item = await getListItem(userId, listId, access.index, itemId);
    if (item === undefined) throw itemNotFound();
    return item;
  });
}
