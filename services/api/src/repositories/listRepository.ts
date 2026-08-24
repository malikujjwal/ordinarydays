import { MAX_AUTOMATIC_INTENT_AGE_DAYS } from '@od/shared';
import {
  compareListItems,
  LexoRankOverflowError,
  lexoRankBetween,
} from '@od/shared/rank';
import {
  activity as activitySchema,
  listIndex as listIndexSchema,
  listItemActivityLink as listItemActivityLinkSchema,
  listItem as listItemSchema,
  listMember as listMemberSchema,
  list as listSchema,
} from '@od/shared/schemas';
import type {
  Activity,
  DefaultSlot,
  List,
  ListCapabilities,
  ListIndex,
  ListItem,
  ListItemActivityLink,
  ListItemDetails,
  ListMember,
} from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { clearListProvenance } from './activityRepository.js';
import {
  batchGetItems,
  deleteAll,
  getItem,
  type Page,
  putItem,
  query,
  queryAll,
  queryCount,
} from './base.js';
import {
  decodeCursor,
  decodeFencedCursor,
  encodeCursor,
  encodeFencedCursor,
  type PageKey,
} from './cursor.js';
import { receiptItem } from './idempotencyRepository.js';
import {
  activityMeta,
  activityTombstone,
  listItemActivityLink,
  listItem as listItemKey,
  listItemLocator,
  listItemPrefix,
  listItemTombstone,
  listMember as listMemberKey,
  listMemberPrefix,
  listMeta,
  listPartition,
  listPointer,
  listPointerPrefix,
  listRankRepair,
  listTombstone,
  listUndo,
  sourceList,
} from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';
import { removeDefaultListTransactItem } from './userRepository.js';

/**
 * The storage half of Lists and ListItems (`data-model.md` patterns 7, 8, 8b and 8d).
 *
 * This module stores rather than decides. Services resolve templates, validate capabilities,
 * authorise through `assertListAccess`, hash Undo tokens, and orchestrate repair/migration.
 * Every write here is deterministic: ids and timestamps are arguments, never minted or read
 * inside a mutation. The exported generators sit beside those writes for callers that need
 * server-minted identities, matching `activityRepository.ts`.
 *
 * Every list-scoped method keeps `userId` first and requires the opaque result of the exact
 * caller-pointer read. Role policy is still enforced once in `services/authz.ts`; the grant
 * only prevents a caller from bypassing that pointer read before reaching canonical storage.
 */

const nextListUlid = monotonicFactory();
const nextItemUlid = monotonicFactory();
const nextOperationUlid = monotonicFactory();

export function newListId(): string {
  return `lst_${nextListUlid()}`;
}

export function newItemId(): string {
  return `itm_${nextItemUlid()}`;
}

export function newListOperationId(): string {
  return `op_${nextOperationUlid()}`;
}

const ENTITY = {
  list: 'List',
  index: 'ListIndex',
  item: 'ListItem',
  locator: 'ListItemLocator',
  itemTombstone: 'ListItemTombstone',
  link: 'ListItemActivityLink',
  /** Written first in Phase 6; the delete cascade already iterates it (§P3-05). */
  member: 'ListMember',
  rankRepair: 'ListRankRepair',
  undo: 'ListUndo',
  tombstone: 'ListTombstone',
  sourceList: 'SourceList',
} as const;

const SCHEMA_VERSION = 1;
const PAGE_SIZE = 50;
const TABLE_KEY = ['pk', 'sk'] as const;
const MAX_MUTATION_ATTEMPTS = 5;

const GATE_NAMES = {
  '#rankRepairId': 'rankRepairId',
  '#behaviourMigrationId': 'behaviourMigrationId',
} as const;
const GATES_ABSENT =
  'attribute_not_exists(#rankRepairId) AND attribute_not_exists(#behaviourMigrationId)';

function listDeletionGate(listId: string) {
  return {
    ConditionCheck: {
      Key: listTombstone(listId),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

const locatorSchema = z.object({
  listId: z.string(),
  itemId: z.string(),
  rank: z.string().min(1),
  itemRevision: z.number().int().nonnegative(),
});

const itemTombstoneSchema = z.object({
  listId: z.string(),
  itemId: z.string(),
  operationId: z.string().min(1),
  snapshot: listItemSchema,
  viewerLinks: z.array(listItemActivityLinkSchema).default([]),
  activityProvenance: z
    .array(
      z.object({
        activityId: z.string().min(1),
        listId: z.string().min(1),
        listItemId: z.string().min(1),
      }),
    )
    .default([]),
});

type Locator = z.infer<typeof locatorSchema>;
type ItemTombstone = z.infer<typeof itemTombstoneSchema>;

const LIST_ACCESS_GRANT = Symbol('ListAccessGrant');
const issuedListAccessGrants = new WeakSet<ListAccessGrant>();

/** Opaque proof that the exact caller/list pointer existed when access was checked. */
export interface ListAccessGrant extends ListIndex {
  readonly [LIST_ACCESS_GRANT]: true;
}

class RepositoryListAccessGrant implements ListAccessGrant {
  readonly [LIST_ACCESS_GRANT] = true;
  readonly listId: string;
  readonly userId: ListIndex['userId'];
  readonly role: ListIndex['role'];
  readonly addedAt: string;

  constructor(index: ListIndex) {
    this.listId = index.listId;
    this.userId = index.userId;
    this.role = index.role;
    this.addedAt = index.addedAt;
    issuedListAccessGrants.add(this);
    Object.freeze(this);
  }
}

/** A client-minted list id collided with a live row or retained tombstone. */
export class ListIdUnavailableError extends Error {
  constructor() {
    super('That id is not available.');
    this.name = 'ListIdUnavailableError';
  }
}

/** A client-minted item id collided with a live locator or retained tombstone. */
export class ListItemIdUnavailableError extends Error {
  constructor() {
    super('That id is not available.');
    this.name = 'ListItemIdUnavailableError';
  }
}

/** A list is absent, inaccessible to this caller, or already being deleted. */
export class ListNotFoundError extends AppError {
  constructor() {
    super('not_found', 'List not found.');
    this.name = 'ListNotFoundError';
  }
}

/** An exact stable-id read could not resolve a live item. */
export class ListItemNotFoundError extends Error {
  constructor() {
    super('List item not found.');
    this.name = 'ListItemNotFoundError';
  }
}

/** A public item read crossed a rank/behaviour generation and must be retried from page one. */
export class ListReadFenceError extends Error {
  constructor() {
    super('The list changed while it was being read.');
    this.name = 'ListReadFenceError';
  }
}

/** Equal-rank neighbours or rank overflow require P3-08's bounded repair worker. */
export class ListRankRepairRequiredError extends Error {
  constructor() {
    super('List ranks must be repaired before this item can be moved.');
    this.name = 'ListRankRepairRequiredError';
  }
}

/** The internal revision/version retry bound was exhausted. */
export class ListMutationRetryExhaustedError extends Error {
  constructor() {
    super('The list kept changing while the update was being applied.');
    this.name = 'ListMutationRetryExhaustedError';
  }
}

/** A retained Undo operation no longer names a restorable tombstone. */
export class ListUndoNotApplicableError extends Error {
  constructor() {
    super('This undo is no longer applicable.');
    this.name = 'ListUndoNotApplicableError';
  }
}

class RetryableListMutationConflictError extends Error {
  constructor() {
    super('Retry the list mutation against current storage state.');
    this.name = 'RetryableListMutationConflictError';
  }
}

function stamp(
  entity: string,
  createdAt: string,
  updatedAt: string,
  item: Record<string, unknown>,
): StoredItem {
  return {
    ...item,
    entity,
    createdAt,
    updatedAt,
    schemaVersion: SCHEMA_VERSION,
  };
}

function parseList(value: unknown): List {
  return listSchema.parse(value) as List;
}

function parseListIndex(value: unknown): ListIndex {
  return listIndexSchema.parse(value) as ListIndex;
}

function parseListItem(value: unknown): ListItem {
  return listItemSchema.parse(value) as ListItem;
}

function parseListItemActivityLink(value: unknown): ListItemActivityLink {
  return listItemActivityLinkSchema.parse(value) as ListItemActivityLink;
}

function parseListMember(value: unknown): ListMember {
  return listMemberSchema.parse(value) as ListMember;
}

function parseActivity(value: unknown): Activity {
  return activitySchema.parse(value) as Activity;
}

function assertListAccessGrant(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): void {
  if (
    !issuedListAccessGrants.has(access) ||
    access.userId !== userId ||
    access.listId !== listId
  ) {
    throw new ListNotFoundError();
  }
}

async function getLiveListMetaStrong(listId: string): Promise<List | undefined> {
  const row = await getItem<StoredItem>(listMeta(listId), { consistentRead: true });
  if (row === undefined) return undefined;
  const deleting = await getItem<StoredItem>(listTombstone(listId), {
    consistentRead: true,
  });
  return deleting === undefined ? parseList(row) : undefined;
}

function assertFenceOpen(list: List): void {
  if (list.rankRepairId !== undefined || list.behaviourMigrationId !== undefined) {
    throw new ListReadFenceError();
  }
}

function assertSameFence(before: List, after: List): void {
  if (after.rankVersion !== before.rankVersion) {
    throw new ListReadFenceError();
  }
  assertFenceOpen(after);
}

function ttlFor(now: string): number {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp))
    throw new Error('List mutation received an invalid now.');
  return Math.floor(timestamp / 1000) + MAX_AUTOMATIC_INTENT_AGE_DAYS * 24 * 60 * 60;
}

export interface CreateListOptions {
  readonly now: string;
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/**
 * Creates canonical META, owner pointer, optional source projection and receipt atomically.
 *
 * When the list carries a `sourceActivityId`, the same transaction **re-asserts** at commit
 * time what the service verified before it: the source Activity still exists, still belongs
 * to the caller, is still a Plan, and is not mid-deletion. Without those checks a Plan
 * deleted or converted between the service's read and this write would leave a fresh
 * projection under a gone or wrong-kind Activity partition; a failed check cancels the
 * whole create as the ordinary safe `conflict`.
 */
export async function createList(
  userId: string,
  list: List,
  options: CreateListOptions,
): Promise<void> {
  const items = [
    {
      Put: {
        Item: stamp(ENTITY.list, options.now, list.updatedAt, {
          ...listMeta(list.listId),
          ...list,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      ConditionCheck: {
        Key: listTombstone(list.listId),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    },
    {
      Put: {
        Item: stamp(ENTITY.index, options.now, options.now, {
          ...listPointer(userId, list.listId),
          listId: list.listId,
          userId,
          role: 'owner',
          addedAt: options.now,
        }),
      },
    },
    ...(list.sourceActivityId === undefined
      ? []
      : [
          {
            Put: {
              Item: stamp(ENTITY.sourceList, options.now, options.now, {
                ...sourceList(list.sourceActivityId, list.listId),
                activityId: list.sourceActivityId,
                listId: list.listId,
              }),
            },
          },
          {
            ConditionCheck: {
              Key: activityMeta(list.sourceActivityId),
              ConditionExpression:
                'attribute_exists(pk) AND #ownerId = :sourceOwner AND #objectKind = :plan',
              ExpressionAttributeNames: {
                '#ownerId': 'ownerId',
                '#objectKind': 'objectKind',
              },
              ExpressionAttributeValues: { ':sourceOwner': userId, ':plan': 'plan' },
            },
          },
          {
            ConditionCheck: {
              Key: activityTombstone(list.sourceActivityId),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ]),
  ] as const;

  const builder = new TransactionBuilder(
    'createList',
    options.idempotencyReceipt === undefined ? 0 : 1,
  ).add(...items);
  const receiptIndex = builder.length;
  if (options.idempotencyReceipt !== undefined) {
    builder.addReserved(receiptItem(options.idempotencyReceipt));
  }

  await transactWrite(builder.build(), {
    operation: 'createList',
    onConditionFailed: (index) => {
      if (index === 0 || index === 1) return new ListIdUnavailableError();
      // A failed source-Plan re-assertion falls through to the default safe conflict.
      return options.idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined;
    },
  });
}

/** The exact pointer read used by `assertListAccess`; no List partition read occurs here. */
export async function getListPointer(
  userId: string,
  listId: string,
): Promise<ListAccessGrant | undefined> {
  const row = await getItem<StoredItem>(listPointer(userId, listId), {
    consistentRead: true,
  });
  return row === undefined
    ? undefined
    : new RepositoryListAccessGrant(parseListIndex(row));
}

/** Canonical META read for list-level services. Fence readers use the same strong form. */
export async function getListMeta(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<List | undefined> {
  assertListAccessGrant(userId, listId, access);
  return getLiveListMetaStrong(listId);
}

/**
 * The delete path's META read: strong and deliberately **not** tombstone-filtered, so a
 * retried `DELETE` can resume a cascade whose tombstone is already down while META and the
 * pointer still exist. Every other reader goes through {@link getListMeta}, which hides a
 * deleting list; only the owner-only delete service may see one mid-cascade.
 */
export async function getListMetaForDeletion(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<List | undefined> {
  assertListAccessGrant(userId, listId, access);
  const row = await getItem<StoredItem>(listMeta(listId), { consistentRead: true });
  return row === undefined ? undefined : parseList(row);
}

export interface UserListEntry {
  readonly list: List;
  readonly index: ListIndex;
}

/** Pattern 7: one pointer Query and one META BatchGet, restored to pointer order. */
export async function listListsForUser(
  userId: string,
  cursor?: string,
): Promise<Page<UserListEntry>> {
  const prefix = listPointerPrefix(userId);
  const pointerPage = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      keyAttributes: TABLE_KEY,
    },
  );
  const pointers = pointerPage.items.map(parseListIndex);
  const rows = await batchGetItems<StoredItem>(
    pointers.flatMap((pointer) => [
      listMeta(pointer.listId),
      listTombstone(pointer.listId),
    ]),
  );
  const lists = new Map(
    rows
      .filter((row) => row.entity === ENTITY.list)
      .map((row) => {
        const list = parseList(row);
        return [list.listId, list] as const;
      }),
  );
  const deleting = new Set(
    rows
      .filter((row) => row.entity === ENTITY.tombstone)
      .map((row) => String(row.listId)),
  );

  return {
    items: pointers.flatMap((index) => {
      const list = lists.get(index.listId);
      return list === undefined || deleting.has(index.listId) ? [] : [{ list, index }];
    }),
    ...(pointerPage.nextCursor === undefined
      ? {}
      : { nextCursor: pointerPage.nextCursor }),
  };
}

/**
 * The owner-only count P3-05 uses for the 100-owned-list creation cap.
 *
 * Strongly consistent, so a sequential create-then-create cannot slip past the cap on a
 * stale replica. Two genuinely **concurrent** creates can still both observe 99 — closing
 * that needs a per-user counter advanced in the create transaction, which is a new access
 * pattern awaiting a `data-model.md` row; §P3-05 prescribes the pointer count, so the gap
 * is raised in the PR rather than silently redesigned.
 */
export async function countOwnedLists(userId: string): Promise<number> {
  const prefix = listPointerPrefix(userId);
  return queryCount(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      consistentRead: true,
      filterEquals: { attribute: 'role', value: 'owner' },
      keyAttributes: TABLE_KEY,
    },
  );
}

export interface ListItemPage {
  readonly list: List;
  readonly items: ListItem[];
  readonly itemIds: string[];
  readonly nextCursor?: string;
}

/** Patterns 8/8b: fenced META + strongly consistent 50-item page. */
export async function listItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  cursor?: string,
): Promise<ListItemPage | undefined> {
  assertListAccessGrant(userId, listId, access);
  const before = await getLiveListMetaStrong(listId);
  if (before === undefined) return undefined;
  assertFenceOpen(before);

  const fencedCursor = decodeFencedCursor(cursor, TABLE_KEY);
  if (fencedCursor !== undefined && fencedCursor.rankVersion !== before.rankVersion) {
    throw new ListReadFenceError();
  }

  const prefix = listItemPrefix(listId);
  const rawCursor =
    fencedCursor === undefined ? undefined : encodeCursor(fencedCursor.lastEvaluatedKey);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      consistentRead: true,
      limit: PAGE_SIZE,
      ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
      keyAttributes: TABLE_KEY,
    },
  );
  const items = page.items.map(parseListItem).sort(compareListItems);

  const after = await getLiveListMetaStrong(listId);
  if (after === undefined) return undefined;
  assertSameFence(before, after);

  const lastEvaluatedKey = decodeCursor(page.nextCursor, TABLE_KEY);
  const nextCursor = encodeFencedCursor(lastEvaluatedKey, before.rankVersion);
  return {
    list: before,
    items,
    itemIds: items.map((item) => item.itemId),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Caller-keyed BatchGet only; another viewer's LNK row is never read or returned. */
export async function batchGetViewerLinks(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemIds: readonly string[],
): Promise<ListItemActivityLink[]> {
  assertListAccessGrant(userId, listId, access);
  const before = await getLiveListMetaStrong(listId);
  if (before === undefined) throw new ListNotFoundError();
  assertFenceOpen(before);
  const uniqueIds = [...new Set(itemIds)];
  const rows = await batchGetItems<StoredItem>(
    uniqueIds.map((itemId) => listItemActivityLink(listId, userId, itemId)),
  );
  const byItemId = new Map(
    rows.map((row) => {
      const link = parseListItemActivityLink(row);
      return [link.itemId, link] as const;
    }),
  );
  const links = uniqueIds.flatMap((itemId) => {
    const link = byItemId.get(itemId);
    return link === undefined ? [] : [link];
  });
  const after = await getLiveListMetaStrong(listId);
  if (after === undefined) throw new ListNotFoundError();
  assertSameFence(before, after);
  return links;
}

interface ResolvedItem {
  readonly item: ListItem;
  readonly locator: Locator;
  readonly row: StoredItem;
}

async function resolveItemStrong(
  listId: string,
  itemId: string,
): Promise<ResolvedItem | undefined> {
  const locatorRow = await getItem<StoredItem>(listItemLocator(listId, itemId), {
    consistentRead: true,
  });
  if (locatorRow === undefined) return undefined;
  const locator = locatorSchema.parse(locatorRow);
  const row = await getItem<StoredItem>(listItemKey(listId, locator.rank, itemId), {
    consistentRead: true,
  });
  if (row === undefined) return undefined;
  const item = parseListItem(row);
  if (
    item.rank !== locator.rank ||
    item.itemRevision !== locator.itemRevision ||
    item.itemId !== locator.itemId
  ) {
    throw new ListReadFenceError();
  }
  return { item, locator, row };
}

/** Pattern 8d: locator-following exact read within the same strong META fence. */
export async function getListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
): Promise<ListItem | undefined> {
  assertListAccessGrant(userId, listId, access);
  const before = await getLiveListMetaStrong(listId);
  if (before === undefined) return undefined;
  assertFenceOpen(before);

  const resolved = await resolveItemStrong(listId, itemId);
  const after = await getLiveListMetaStrong(listId);
  if (after === undefined) return undefined;
  assertSameFence(before, after);
  return resolved?.item;
}

export interface ListMetaPatch {
  readonly title?: string;
  readonly capabilities?: ListCapabilities;
  readonly slot?: List['slot'];
  readonly archived?: boolean;
}

/** One conditional META Update; renaming therefore writes exactly one item. */
export async function patchListMeta(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  patch: ListMetaPatch,
  expectedUpdatedAt: string,
  updatedAt: string,
): Promise<List | undefined> {
  assertListAccessGrant(userId, listId, access);
  const names: Record<string, string> = {
    '#updatedAt': 'updatedAt',
    ...GATE_NAMES,
  };
  const values: Record<string, unknown> = {
    ':expectedUpdatedAt': expectedUpdatedAt,
    ':updatedAt': updatedAt,
  };
  const sets = ['#updatedAt = :updatedAt'];

  for (const field of ['title', 'capabilities', 'slot', 'archived'] as const) {
    if (!(field in patch)) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = patch[field];
    sets.push(`#${field} = :${field}`);
  }

  await transactWrite(
    [
      {
        ConditionCheck: {
          Key: listTombstone(listId),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          Key: listMeta(listId),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: `#updatedAt = :expectedUpdatedAt AND ${GATES_ABSENT}`,
        },
      },
    ],
    {
      operation: 'patchListMeta',
      onConditionFailed: (index) => (index === 0 ? new ListNotFoundError() : undefined),
    },
  );
  return getLiveListMetaStrong(listId);
}

export type NewListItem = Omit<ListItem, 'listId' | 'rank' | 'itemRevision'>;

export interface CreateListItemsOptions {
  readonly now: string;
  /** `null` means the front; `undefined` means the end. */
  readonly afterItemId?: string | null;
  /**
   * Builds the receipt **after** ranks are allocated, unlike every other write path's plain
   * `idempotencyReceipt`.
   *
   * It has to be a callback: `rank` is decided inside this function, from neighbours read
   * under the version condition, and a receipt built before that would store — and replay
   * for the next 24 hours — a response whose rank is a placeholder and whose server-minted
   * id was never written. A stored response must be the response.
   */
  readonly receiptFor?: (items: ListItem[]) => IdempotencyReceipt;
}

interface MutationState {
  readonly list: List;
  readonly resolved?: ResolvedItem;
}

async function readMutationState(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId?: string,
): Promise<MutationState> {
  assertListAccessGrant(userId, listId, access);
  const list = await getLiveListMetaStrong(listId);
  if (list === undefined) throw new ListNotFoundError();
  assertFenceOpen(list);
  if (itemId === undefined) return { list };
  const resolved = await resolveItemStrong(listId, itemId);
  if (resolved === undefined) throw new ListItemNotFoundError();
  return { list, resolved };
}

async function queryItemsFrom(
  listId: string,
  options: { readonly ascending: boolean; readonly cursorKey?: PageKey },
): Promise<ListItem[]> {
  const prefix = listItemPrefix(listId);
  const cursor =
    options.cursorKey === undefined ? undefined : encodeCursor(options.cursorKey);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      consistentRead: true,
      ascending: options.ascending,
      limit: 3,
      ...(cursor === undefined ? {} : { cursor }),
      keyAttributes: TABLE_KEY,
    },
  );
  return page.items.map(parseListItem);
}

interface Neighbours {
  readonly prev?: ListItem;
  readonly next?: ListItem;
  readonly surrounding: ListItem[];
}

async function readNeighbours(
  listId: string,
  afterItemId: string | null | undefined,
  excludedItemId?: string,
): Promise<Neighbours> {
  const retain = (items: ListItem[]) =>
    items.filter((item) => item.itemId !== excludedItemId);

  if (afterItemId === null) {
    const following = retain(await queryItemsFrom(listId, { ascending: true }));
    return {
      ...(following[0] === undefined ? {} : { next: following[0] }),
      surrounding: following,
    };
  }

  if (afterItemId === undefined) {
    const preceding = retain(await queryItemsFrom(listId, { ascending: false }));
    return {
      ...(preceding[0] === undefined ? {} : { prev: preceding[0] }),
      surrounding: preceding,
    };
  }

  if (afterItemId === excludedItemId) {
    throw new ListItemNotFoundError();
  }
  const after = await resolveItemStrong(listId, afterItemId);
  if (after === undefined) throw new ListItemNotFoundError();
  const cursorKey = listItemKey(listId, after.item.rank, after.item.itemId);
  const [preceding, following] = await Promise.all([
    queryItemsFrom(listId, { ascending: false, cursorKey }),
    queryItemsFrom(listId, { ascending: true, cursorKey }),
  ]);
  const retainedPreceding = retain(preceding);
  const retainedFollowing = retain(following);
  return {
    prev: after.item,
    ...(retainedFollowing[0] === undefined ? {} : { next: retainedFollowing[0] }),
    surrounding: [...retainedPreceding, after.item, ...retainedFollowing],
  };
}

function assertNeighboursRepairFree(neighbours: Neighbours): void {
  for (const neighbour of [neighbours.prev, neighbours.next]) {
    if (neighbour === undefined) continue;
    if (
      neighbours.surrounding.some(
        (candidate) =>
          candidate.itemId !== neighbour.itemId && candidate.rank === neighbour.rank,
      )
    ) {
      throw new ListRankRepairRequiredError();
    }
  }
  if (
    neighbours.prev !== undefined &&
    neighbours.next !== undefined &&
    neighbours.prev.rank >= neighbours.next.rank
  ) {
    throw new ListRankRepairRequiredError();
  }
}

function allocateRanks(neighbours: Neighbours, count: number): string[] {
  assertNeighboursRepairFree(neighbours);
  const ranks: string[] = [];
  let lower = neighbours.prev?.rank ?? null;
  const upper = neighbours.next?.rank ?? null;
  try {
    for (let index = 0; index < count; index += 1) {
      const rank = lexoRankBetween(lower, upper);
      ranks.push(rank);
      lower = rank;
    }
  } catch (error) {
    if (error instanceof LexoRankOverflowError) {
      throw new ListRankRepairRequiredError();
    }
    throw error;
  }
  return ranks;
}

async function retryMutation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof RetryableListMutationConflictError)) throw error;
    }
  }
  throw new ListMutationRetryExhaustedError();
}

function storedListItem(item: ListItem, now: string): StoredItem {
  return stamp(ENTITY.item, now, now, {
    ...listItemKey(item.listId, item.rank, item.itemId),
    ...item,
  });
}

function storedLocator(item: ListItem, now: string): StoredItem {
  return stamp(ENTITY.locator, now, now, {
    ...listItemLocator(item.listId, item.itemId),
    listId: item.listId,
    itemId: item.itemId,
    rank: item.rank,
    itemRevision: item.itemRevision,
  });
}

function storedListItemActivityLink(link: ListItemActivityLink, now: string): StoredItem {
  return stamp(ENTITY.link, now, now, {
    ...listItemActivityLink(link.listId, link.viewerUserId, link.itemId),
    ...link,
  });
}

type ActivityProvenance = ItemTombstone['activityProvenance'][number];

interface RelationshipSnapshot {
  readonly viewerIds: string[];
  readonly viewerLinks: ListItemActivityLink[];
  readonly activityProvenance: ActivityProvenance[];
}

async function activeViewerIds(list: List): Promise<string[]> {
  const prefix = listMemberPrefix(list.listId);
  const rows = await queryAll<StoredItem>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  const members = rows.map(parseListMember);
  return [
    ...new Set([
      list.ownerId,
      ...members.flatMap((member) =>
        member.status === 'active' && member.userId !== undefined ? [member.userId] : [],
      ),
    ]),
  ];
}

async function readRelationshipSnapshot(
  list: List,
  itemId: string,
): Promise<RelationshipSnapshot> {
  const viewerIds = await activeViewerIds(list);
  const linkRows = await batchGetItems<StoredItem>(
    viewerIds.map((viewerUserId) =>
      listItemActivityLink(list.listId, viewerUserId, itemId),
    ),
    { consistentRead: true },
  );
  const linksByViewer = new Map(
    linkRows.flatMap((row) => {
      const link = parseListItemActivityLink(row);
      return link.listId === list.listId && itemId === link.itemId
        ? ([[link.viewerUserId, link]] as const)
        : [];
    }),
  );
  const viewerLinks = viewerIds.flatMap((viewerUserId) => {
    const link = linksByViewer.get(viewerUserId);
    return link === undefined ? [] : [link];
  });
  const activityRows = await batchGetItems<StoredItem>(
    [...new Set(viewerLinks.map((link) => link.activityId))].map(activityMeta),
    { consistentRead: true },
  );
  const activities = new Map(
    activityRows.map((row) => {
      const activity = parseActivity(row);
      return [activity.activityId, activity] as const;
    }),
  );
  const activityProvenance = [
    ...new Set(viewerLinks.map((link) => link.activityId)),
  ].flatMap((activityId): ActivityProvenance[] => {
    const activity = activities.get(activityId);
    return activity !== undefined &&
      activity.listId === list.listId &&
      activity.listItemId === itemId
      ? [
          {
            activityId: activity.activityId,
            listId: activity.listId,
            listItemId: activity.listItemId,
          },
        ]
      : [];
  });
  return { viewerIds, viewerLinks, activityProvenance };
}

interface RestorableRelationships {
  readonly linksToPut: ListItemActivityLink[];
  readonly activityProvenanceToPut: ActivityProvenance[];
}

async function readRestorableRelationships(
  list: List,
  tombstone: ItemTombstone,
): Promise<RestorableRelationships> {
  const activeViewers = new Set(await activeViewerIds(list));
  const snapshotProvenance = new Map(
    tombstone.activityProvenance.map((provenance) => [provenance.activityId, provenance]),
  );
  const candidateLinks = tombstone.viewerLinks.filter(
    (link) =>
      link.listId === tombstone.listId &&
      link.itemId === tombstone.itemId &&
      activeViewers.has(link.viewerUserId) &&
      snapshotProvenance.has(link.activityId),
  );
  const currentLinkRows = await batchGetItems<StoredItem>(
    candidateLinks.map((link) =>
      listItemActivityLink(link.listId, link.viewerUserId, link.itemId),
    ),
    { consistentRead: true },
  );
  const currentLinks = new Map(
    currentLinkRows.map((row) => {
      const link = parseListItemActivityLink(row);
      return [link.viewerUserId, link] as const;
    }),
  );
  const relationshipLinks = candidateLinks.filter((link) => {
    const current = currentLinks.get(link.viewerUserId);
    return current === undefined || current.activityId === link.activityId;
  });
  const activityRows = await batchGetItems<StoredItem>(
    [...new Set(relationshipLinks.map((link) => link.activityId))].map(activityMeta),
    { consistentRead: true },
  );
  const currentActivities = new Map(
    activityRows.map((row) => {
      const activity = parseActivity(row);
      return [activity.activityId, activity] as const;
    }),
  );
  const restorableActivityIds = new Set<string>();
  const activityProvenanceToPut: ActivityProvenance[] = [];
  for (const [activityId, provenance] of snapshotProvenance) {
    const activity = currentActivities.get(activityId);
    if (activity === undefined) continue;
    if (
      activity.listId === provenance.listId &&
      activity.listItemId === provenance.listItemId
    ) {
      restorableActivityIds.add(activityId);
      continue;
    }
    if (activity.listId === undefined && activity.listItemId === undefined) {
      restorableActivityIds.add(activityId);
      activityProvenanceToPut.push(provenance);
    }
  }
  return {
    linksToPut: relationshipLinks.filter(
      (link) =>
        currentLinks.get(link.viewerUserId) === undefined &&
        restorableActivityIds.has(link.activityId),
    ),
    activityProvenanceToPut,
  };
}

/**
 * Which of these item ids already have a live locator.
 *
 * The post-receipt replay guard for bulk (§P3-08): once the 24-hour receipt has expired,
 * replay protection falls to the stable client-minted ids, so a chunk resolves what is
 * already committed and writes only the remainder rather than failing the whole batch on an
 * `attribute_not_exists` condition it can no longer distinguish from a genuine collision.
 *
 * A tombstoned id has no locator and is deliberately **absent** from this set: an ordinary
 * create must still fail against its tombstone, which is P3-10's restore path's to reclaim.
 */
export async function resolveExistingItemIds(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemIds: readonly string[],
): Promise<Set<string>> {
  assertListAccessGrant(userId, listId, access);
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return new Set();
  const rows = await batchGetItems<StoredItem>(
    uniqueIds.map((itemId) => listItemLocator(listId, itemId)),
    { consistentRead: true },
  );
  return new Set(rows.map((row) => locatorSchema.parse(row).itemId));
}

/** Single-create entry point; bulk uses the same chunk transaction below. */
export async function createListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  item: NewListItem,
  options: CreateListItemsOptions,
): Promise<ListItem> {
  const created = await createListItems(userId, listId, access, [item], options);
  const first = created[0];
  if (first === undefined) throw new Error('Single list-item create produced no item.');
  return first;
}

/** One ordered bulk chunk: all ranks come from one META version and advance it once. */
export async function createListItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  items: readonly NewListItem[],
  options: CreateListItemsOptions,
): Promise<ListItem[]> {
  assertListAccessGrant(userId, listId, access);
  if (items.length === 0) return [];

  return retryMutation(async () => {
    const state = await readMutationState(userId, listId, access);
    const neighbours = await readNeighbours(listId, options.afterItemId);
    const ranks = allocateRanks(neighbours, items.length);
    const created = items.map(
      (item, index): ListItem => ({
        ...item,
        listId,
        rank: ranks[index] as string,
        itemRevision: 0,
      }),
    );

    const builder = new TransactionBuilder(
      'createListItems',
      options.receiptFor === undefined ? 0 : 1,
    ).add(listDeletionGate(listId));
    const deletionGateIndex = 0;
    for (const item of created) {
      builder.add(
        {
          Put: {
            Item: storedListItem(item, options.now),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            Item: storedLocator(item, options.now),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          ConditionCheck: {
            Key: listItemTombstone(listId, item.itemId),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      );
    }

    const metaIndex = builder.length;
    const unchecked = created.filter((item) => !item.checked).length;
    builder.add({
      Update: {
        Key: listMeta(listId),
        UpdateExpression:
          'SET #rankVersion = :nextVersion, #itemCount = #itemCount + :count, #uncheckedCount = #uncheckedCount + :unchecked',
        ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
        ExpressionAttributeNames: {
          '#rankVersion': 'rankVersion',
          '#itemCount': 'itemCount',
          '#uncheckedCount': 'uncheckedCount',
          ...GATE_NAMES,
        },
        ExpressionAttributeValues: {
          ':expectedVersion': state.list.rankVersion,
          ':nextVersion': state.list.rankVersion + 1,
          ':count': created.length,
          ':unchecked': unchecked,
        },
      },
    });
    const receiptIndex = builder.length;
    if (options.receiptFor !== undefined) {
      builder.addReserved(receiptItem(options.receiptFor(created)));
    }

    await transactWrite(builder.build(), {
      operation: 'createListItems',
      onConditionFailed: (index) => {
        if (index === deletionGateIndex) return new ListNotFoundError();
        if (index < metaIndex) return new ListItemIdUnavailableError();
        if (index === metaIndex) return new RetryableListMutationConflictError();
        return options.receiptFor !== undefined && index === receiptIndex
          ? new IdempotencyRaceError()
          : undefined;
      },
    });
    return created;
  });
}

export interface ReorderListItemOptions {
  readonly now: string;
  /** `null` means the front; `undefined` means the end. */
  readonly afterItemId?: string | null;
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/** Exactly four domain actions: delete, put, locator move and META version advance. */
export async function reorderListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  options: ReorderListItemOptions,
): Promise<ListItem> {
  return retryMutation(async () => {
    const state = await readMutationState(userId, listId, access, itemId);
    const current = state.resolved;
    if (current === undefined) throw new ListItemNotFoundError();
    const neighbours = await readNeighbours(listId, options.afterItemId, itemId);
    const rank = allocateRanks(neighbours, 1)[0] as string;
    if (rank === current.item.rank) return current.item;

    const nextRevision = current.item.itemRevision + 1;
    const next: ListItem = { ...current.item, rank, itemRevision: nextRevision };
    const nextRow: StoredItem = {
      ...current.row,
      ...listItemKey(listId, rank, itemId),
      rank,
      itemRevision: nextRevision,
      updatedAt: options.now,
    };
    const builder = new TransactionBuilder(
      'reorderListItem',
      options.idempotencyReceipt === undefined ? 0 : 1,
    ).add(
      listDeletionGate(listId),
      {
        Delete: {
          Key: listItemKey(listId, current.item.rank, itemId),
          ConditionExpression: '#itemRevision = :expectedRevision',
          ExpressionAttributeNames: { '#itemRevision': 'itemRevision' },
          ExpressionAttributeValues: {
            ':expectedRevision': current.item.itemRevision,
          },
        },
      },
      {
        Put: {
          Item: nextRow,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          Key: listItemLocator(listId, itemId),
          UpdateExpression:
            'SET #rank = :rank, #itemRevision = :nextRevision, #updatedAt = :updatedAt',
          ConditionExpression:
            '#rank = :expectedRank AND #itemRevision = :expectedRevision',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':rank': rank,
            ':expectedRank': current.item.rank,
            ':expectedRevision': current.item.itemRevision,
            ':nextRevision': nextRevision,
            ':updatedAt': options.now,
          },
        },
      },
      {
        Update: {
          Key: listMeta(listId),
          UpdateExpression: 'SET #rankVersion = :nextVersion',
          ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
          ExpressionAttributeNames: {
            '#rankVersion': 'rankVersion',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':expectedVersion': state.list.rankVersion,
            ':nextVersion': state.list.rankVersion + 1,
          },
        },
      },
    );
    const receiptIndex = builder.length;
    if (options.idempotencyReceipt !== undefined) {
      builder.addReserved(receiptItem(options.idempotencyReceipt));
    }
    await transactWrite(builder.build(), {
      operation: 'reorderListItem',
      onConditionFailed: (index) => {
        if (index === 0) return new ListNotFoundError();
        return options.idempotencyReceipt !== undefined && index === receiptIndex
          ? new IdempotencyRaceError()
          : new RetryableListMutationConflictError();
      },
    });
    return next;
  });
}

export interface ListItemFieldPatch {
  readonly title?: string;
  readonly checked?: boolean;
  readonly note?: string | null;
  readonly location?: ListItem['location'] | null;
  readonly details?: ListItemDetails | null;
}

function applyItemPatch(item: ListItem, patch: ListItemFieldPatch): ListItem {
  const next: ListItem = { ...item, itemRevision: item.itemRevision + 1 };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.checked !== undefined) next.checked = patch.checked;
  for (const field of ['note', 'location', 'details'] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null || value === undefined) delete next[field];
    else Object.assign(next, { [field]: value });
  }
  return next;
}

/** Applies only supplied fields and advances both copies of itemRevision conditionally. */
export async function patchListItemFields(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  patch: ListItemFieldPatch,
  now: string,
): Promise<ListItem> {
  return retryMutation(async () => {
    const state = await readMutationState(userId, listId, access, itemId);
    const current = state.resolved;
    if (current === undefined) throw new ListItemNotFoundError();
    const next = applyItemPatch(current.item, patch);
    const names: Record<string, string> = {
      '#itemRevision': 'itemRevision',
      '#updatedAt': 'updatedAt',
    };
    const values: Record<string, unknown> = {
      ':expectedRevision': current.item.itemRevision,
      ':nextRevision': next.itemRevision,
      ':updatedAt': now,
    };
    const sets = ['#itemRevision = :nextRevision', '#updatedAt = :updatedAt'];
    const removes: string[] = [];

    for (const field of ['title', 'checked', 'note', 'location', 'details'] as const) {
      if (!(field in patch)) continue;
      names[`#${field}`] = field;
      const value = patch[field];
      if (value === null || value === undefined) removes.push(`#${field}`);
      else {
        values[`:${field}`] = value;
        sets.push(`#${field} = :${field}`);
      }
    }

    const builder = new TransactionBuilder('patchListItemFields').add(
      listDeletionGate(listId),
      {
        Update: {
          Key: listItemKey(listId, current.item.rank, itemId),
          UpdateExpression: `SET ${sets.join(', ')}${
            removes.length === 0 ? '' : ` REMOVE ${removes.join(', ')}`
          }`,
          ConditionExpression: '#itemRevision = :expectedRevision',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      {
        Update: {
          Key: listItemLocator(listId, itemId),
          UpdateExpression: 'SET #itemRevision = :nextRevision, #updatedAt = :updatedAt',
          ConditionExpression: '#rank = :rank AND #itemRevision = :expectedRevision',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':rank': current.item.rank,
            ':expectedRevision': current.item.itemRevision,
            ':nextRevision': next.itemRevision,
            ':updatedAt': now,
          },
        },
      },
    );

    const uncheckedDelta =
      current.item.checked === next.checked ? 0 : next.checked ? -1 : 1;
    if (uncheckedDelta === 0) {
      builder.add({
        ConditionCheck: {
          Key: listMeta(listId),
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: GATE_NAMES,
        },
      });
    } else {
      builder.add({
        Update: {
          Key: listMeta(listId),
          UpdateExpression: 'ADD #uncheckedCount :delta',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#uncheckedCount': 'uncheckedCount',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: { ':delta': uncheckedDelta },
        },
      });
    }

    await transactWrite(builder.build(), {
      operation: 'patchListItemFields',
      onConditionFailed: (index) =>
        index === 0 ? new ListNotFoundError() : new RetryableListMutationConflictError(),
    });
    return next;
  });
}

// ── Exceptional rank repair (§P3-03, `data-model.md` §7 "Repair list ranks") ─────────────

/** One item's move, decided once at install time and never recomputed. */
export interface RankRepairEntry {
  readonly itemId: string;
  readonly fromRank: string;
  readonly fromRevision: number;
  readonly toRank: string;
}

/** The resumable work record. Internal: never serialised to a client. */
export interface RankRepairWork {
  readonly listId: string;
  readonly operationId: string;
  readonly entries: RankRepairEntry[];
  /** Index of the next entry to rewrite. A crash resumes here. */
  readonly cursor: number;
  /** The `rankVersion` the marker was installed under. */
  readonly rankVersion: number;
}

const rankRepairSchema = z.object({
  listId: z.string().min(1),
  operationId: z.string().min(1),
  entries: z.array(
    z.object({
      itemId: z.string().min(1),
      fromRank: z.string().min(1),
      fromRevision: z.number().int().nonnegative(),
      toRank: z.string().min(1),
    }),
  ),
  cursor: z.number().int().nonnegative(),
  rankVersion: z.number().int().nonnegative(),
});

/** Items per repair transaction: three actions each, plus the cursor and the deletion gate. */
export const RANK_REPAIR_CHUNK = 25;

/**
 * Every ranked row, unpaged and unfenced — the repair's own snapshot read.
 *
 * Deliberately not `listItems`: that one refuses to read while a marker stands, which is
 * exactly the state this runs in. Bounded by `MAX_LIST_ITEMS`, so `queryAll` is safe here
 * and is not safe for anything a user can grow without limit.
 */
async function readAllItemsForRepair(listId: string): Promise<ListItem[]> {
  const prefix = listItemPrefix(listId);
  const rows = await queryAll<StoredItem>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  return rows.map(parseListItem).sort(compareListItems);
}

/**
 * Installs the repair marker, then snapshots the moves it will make.
 *
 * **Marker first, snapshot second** (§P3-03). Every item mutation condition-checks the
 * marker's absence, so once it is down the snapshot cannot go stale underneath the worker
 * and each entry's `fromRevision` stays true until that entry is rewritten.
 *
 * ## Why every target rank sits above the current maximum
 *
 * A renumber that reuses the occupied range collides with itself: moving A onto a rank B
 * still holds either fails a conditional put or overwrites a row the worker has not copied
 * yet. Stepping up from the current maximum makes every target provably distinct from every
 * current rank — `stepAfter` always returns a strictly greater rank, including when it
 * carries at the length cap — so the rewrite needs no ordering trick and no second pass.
 * The list ends contiguous, evenly spaced one step apart, and free of the equal ranks or
 * exhausted gap that triggered the repair.
 */
export async function beginRankRepair(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  options: { readonly operationId: string; readonly now: string },
): Promise<RankRepairWork> {
  assertListAccessGrant(userId, listId, access);
  const list = await getLiveListMetaStrong(listId);
  if (list === undefined) throw new ListNotFoundError();
  assertFenceOpen(list);

  await transactWrite(
    new TransactionBuilder('beginRankRepair')
      .add(listDeletionGate(listId), {
        Update: {
          Key: listMeta(listId),
          UpdateExpression: 'SET #rankRepairId = :operationId',
          ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
          ExpressionAttributeNames: { '#rankVersion': 'rankVersion', ...GATE_NAMES },
          ExpressionAttributeValues: {
            ':operationId': options.operationId,
            ':expectedVersion': list.rankVersion,
          },
        },
      })
      .build(),
    {
      operation: 'beginRankRepair',
      onConditionFailed: (index) =>
        index === 0 ? new ListNotFoundError() : new RetryableListMutationConflictError(),
    },
  );

  const items = await readAllItemsForRepair(listId);
  let cursor = items.at(-1)?.rank ?? null;
  const entries: RankRepairEntry[] = items.map((item) => {
    const toRank = lexoRankBetween(cursor);
    cursor = toRank;
    return {
      itemId: item.itemId,
      fromRank: item.rank,
      fromRevision: item.itemRevision,
      toRank,
    };
  });

  const work: RankRepairWork = {
    listId,
    operationId: options.operationId,
    entries,
    cursor: 0,
    rankVersion: list.rankVersion,
  };
  await putItem(
    stamp(ENTITY.rankRepair, options.now, options.now, {
      ...listRankRepair(listId, options.operationId),
      ...work,
      ttl: ttlFor(options.now),
    }),
  );
  return work;
}

/** The in-flight work for a marker, or `undefined` when the record has already been cleared. */
export async function getRankRepairWork(
  listId: string,
  operationId: string,
): Promise<RankRepairWork | undefined> {
  const row = await getItem<StoredItem>(listRankRepair(listId, operationId), {
    consistentRead: true,
  });
  return row === undefined ? undefined : rankRepairSchema.parse(row);
}

/**
 * Rewrites one bounded chunk and advances the stored cursor in the same transaction, so a
 * crash resumes at an entry boundary and never half-moves an item.
 *
 * Each entry is three actions — delete the old ranked row at its snapshotted revision, put
 * the row at its new rank with the next revision, move the locator from the same old
 * rank/revision — which is the same shape a single reorder uses, applied in bulk under the
 * marker rather than under `rankVersion`.
 */
export async function applyRankRepairChunk(
  work: RankRepairWork,
): Promise<RankRepairWork> {
  const slice = work.entries.slice(work.cursor, work.cursor + RANK_REPAIR_CHUNK);
  if (slice.length === 0) return work;

  const rows = await batchGetItems<StoredItem>(
    slice.map((entry) => listItemKey(work.listId, entry.fromRank, entry.itemId)),
    { consistentRead: true },
  );
  const byItemId = new Map(rows.map((row) => [String(row.itemId), row]));

  const builder = new TransactionBuilder('applyRankRepairChunk').add(
    listDeletionGate(work.listId),
  );
  for (const entry of slice) {
    const row = byItemId.get(entry.itemId);
    // Gated mutations mean an entry can only be missing if a previous run already moved it;
    // its cursor advance is committed with the same transaction, so that cannot happen at a
    // committed boundary. Treat it as a corrupt snapshot rather than skipping silently.
    if (row === undefined) throw new ListReadFenceError();
    const nextRevision = entry.fromRevision + 1;
    builder.add(
      {
        Delete: {
          Key: listItemKey(work.listId, entry.fromRank, entry.itemId),
          ConditionExpression: '#itemRevision = :expectedRevision',
          ExpressionAttributeNames: { '#itemRevision': 'itemRevision' },
          ExpressionAttributeValues: { ':expectedRevision': entry.fromRevision },
        },
      },
      {
        Put: {
          Item: {
            ...row,
            ...listItemKey(work.listId, entry.toRank, entry.itemId),
            rank: entry.toRank,
            itemRevision: nextRevision,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          Key: listItemLocator(work.listId, entry.itemId),
          UpdateExpression: 'SET #rank = :toRank, #itemRevision = :nextRevision',
          ConditionExpression: '#rank = :fromRank AND #itemRevision = :expectedRevision',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
          },
          ExpressionAttributeValues: {
            ':toRank': entry.toRank,
            ':fromRank': entry.fromRank,
            ':expectedRevision': entry.fromRevision,
            ':nextRevision': nextRevision,
          },
        },
      },
    );
  }

  const nextCursor = work.cursor + slice.length;
  builder.add({
    Update: {
      Key: listRankRepair(work.listId, work.operationId),
      UpdateExpression: 'SET #cursor = :nextCursor',
      ConditionExpression: '#cursor = :expectedCursor',
      ExpressionAttributeNames: { '#cursor': 'cursor' },
      ExpressionAttributeValues: {
        ':nextCursor': nextCursor,
        ':expectedCursor': work.cursor,
      },
    },
  });

  await transactWrite(builder.build(), {
    operation: 'applyRankRepairChunk',
    onConditionFailed: (index) =>
      index === 0 ? new ListNotFoundError() : new RetryableListMutationConflictError(),
  });
  return { ...work, cursor: nextCursor };
}

/**
 * The final transaction: clear the marker, advance `rankVersion` and delete the work row,
 * atomically.
 *
 * Advancing the version is what invalidates every item cursor issued before the repair, so
 * a client paging across the rewrite receives the retryable `503` and restarts at page one
 * rather than resuming through changed sort keys.
 */
export async function finishRankRepair(work: RankRepairWork): Promise<void> {
  await transactWrite(
    new TransactionBuilder('finishRankRepair')
      .add(
        {
          Update: {
            Key: listMeta(work.listId),
            UpdateExpression: 'SET #rankVersion = :nextVersion REMOVE #rankRepairId',
            ConditionExpression:
              '#rankRepairId = :operationId AND #rankVersion = :expectedVersion',
            ExpressionAttributeNames: {
              '#rankVersion': 'rankVersion',
              '#rankRepairId': 'rankRepairId',
            },
            ExpressionAttributeValues: {
              ':operationId': work.operationId,
              ':expectedVersion': work.rankVersion,
              ':nextVersion': work.rankVersion + 1,
            },
          },
        },
        { Delete: { Key: listRankRepair(work.listId, work.operationId) } },
      )
      .build(),
    { operation: 'finishRankRepair' },
  );
}

export interface DeleteListItemOptions {
  readonly operationId: string;
  readonly tokenHash: string;
  readonly undoExpiresAt: string;
  readonly now: string;
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/** Deletes row+locator, records the exact snapshot and advances counters atomically. */
export async function deleteListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  options: DeleteListItemOptions,
): Promise<ListItem> {
  return retryMutation(async () => {
    const state = await readMutationState(userId, listId, access, itemId);
    const current = state.resolved;
    if (current === undefined) throw new ListItemNotFoundError();
    const relationships = await readRelationshipSnapshot(state.list, itemId);
    const ttl = ttlFor(options.now);
    const builder = new TransactionBuilder(
      'deleteListItem',
      options.idempotencyReceipt === undefined ? 0 : 1,
    ).add(
      listDeletionGate(listId),
      {
        Delete: {
          Key: listItemKey(listId, current.item.rank, itemId),
          ConditionExpression: '#itemRevision = :expectedRevision',
          ExpressionAttributeNames: { '#itemRevision': 'itemRevision' },
          ExpressionAttributeValues: {
            ':expectedRevision': current.item.itemRevision,
          },
        },
      },
      {
        Delete: {
          Key: listItemLocator(listId, itemId),
          ConditionExpression: '#rank = :rank AND #itemRevision = :expectedRevision',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
          },
          ExpressionAttributeValues: {
            ':rank': current.item.rank,
            ':expectedRevision': current.item.itemRevision,
          },
        },
      },
    );
    for (const link of relationships.viewerLinks) {
      builder.add({
        Delete: {
          Key: listItemActivityLink(listId, link.viewerUserId, itemId),
          ConditionExpression: '#activityId = :activityId',
          ExpressionAttributeNames: { '#activityId': 'activityId' },
          ExpressionAttributeValues: { ':activityId': link.activityId },
        },
      });
    }
    const linkedViewerIds = new Set(
      relationships.viewerLinks.map((link) => link.viewerUserId),
    );
    for (const viewerUserId of relationships.viewerIds) {
      if (linkedViewerIds.has(viewerUserId)) continue;
      builder.add({
        ConditionCheck: {
          Key: listItemActivityLink(listId, viewerUserId, itemId),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }
    for (const provenance of relationships.activityProvenance) {
      builder.add({
        Update: {
          Key: activityMeta(provenance.activityId),
          UpdateExpression: 'REMOVE #listId, #listItemId',
          ConditionExpression: '#listId = :listId AND #listItemId = :listItemId',
          ExpressionAttributeNames: {
            '#listId': 'listId',
            '#listItemId': 'listItemId',
          },
          ExpressionAttributeValues: {
            ':listId': provenance.listId,
            ':listItemId': provenance.listItemId,
          },
        },
      });
    }
    builder.add(
      {
        Put: {
          Item: stamp(ENTITY.itemTombstone, options.now, options.now, {
            ...listItemTombstone(listId, itemId),
            listId,
            itemId,
            operationId: options.operationId,
            deletedAt: options.now,
            ttl,
            snapshot: current.item,
            viewerLinks: relationships.viewerLinks,
            activityProvenance: relationships.activityProvenance,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          Item: stamp(ENTITY.undo, options.now, options.now, {
            ...listUndo(listId, options.operationId),
            listId,
            operationId: options.operationId,
            kind: 'delete_item',
            affectedItemIds: [itemId],
            tokenHash: options.tokenHash,
            undoExpiresAt: options.undoExpiresAt,
            ttl,
            consumed: false,
          }),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Update: {
          Key: listMeta(listId),
          UpdateExpression: 'ADD #itemCount :minusOne, #uncheckedCount :uncheckedDelta',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#itemCount': 'itemCount',
            '#uncheckedCount': 'uncheckedCount',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':minusOne': -1,
            ':uncheckedDelta': current.item.checked ? 0 : -1,
          },
        },
      },
    );
    const receiptIndex = builder.length;
    if (options.idempotencyReceipt !== undefined) {
      builder.addReserved(receiptItem(options.idempotencyReceipt));
    }
    await transactWrite(builder.build(), {
      operation: 'deleteListItem',
      onConditionFailed: (index) => {
        if (index === 0) return new ListNotFoundError();
        return options.idempotencyReceipt !== undefined && index === receiptIndex
          ? new IdempotencyRaceError()
          : new RetryableListMutationConflictError();
      },
    });
    return current.item;
  });
}

export interface RestoreListItemOptions {
  readonly operationId: string;
  readonly now: string;
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/** The narrow tombstone-aware compensation primitive; ordinary create never calls this. */
export async function restoreListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  options: RestoreListItemOptions,
): Promise<ListItem> {
  return retryMutation(async () => {
    const state = await readMutationState(userId, listId, access);
    const tombstoneRow = await getItem<StoredItem>(listItemTombstone(listId, itemId), {
      consistentRead: true,
    });
    if (tombstoneRow === undefined) throw new ListUndoNotApplicableError();
    const tombstone: ItemTombstone = itemTombstoneSchema.parse(tombstoneRow);
    if (tombstone.operationId !== options.operationId) {
      throw new ListUndoNotApplicableError();
    }
    const item = parseListItem(tombstone.snapshot);
    const relationships = await readRestorableRelationships(state.list, tombstone);
    const builder = new TransactionBuilder(
      'restoreListItem',
      options.idempotencyReceipt === undefined ? 0 : 1,
    ).add(
      listDeletionGate(listId),
      {
        Put: {
          Item: storedListItem(item, options.now),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          Item: storedLocator(item, options.now),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    );
    const relationshipStartIndex = builder.length;
    for (const link of relationships.linksToPut) {
      builder.add({
        Put: {
          Item: storedListItemActivityLink(link, options.now),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }
    for (const provenance of relationships.activityProvenanceToPut) {
      builder.add({
        Update: {
          Key: activityMeta(provenance.activityId),
          UpdateExpression: 'SET #listId = :listId, #listItemId = :listItemId',
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(#listId) AND attribute_not_exists(#listItemId)',
          ExpressionAttributeNames: {
            '#listId': 'listId',
            '#listItemId': 'listItemId',
          },
          ExpressionAttributeValues: {
            ':listId': provenance.listId,
            ':listItemId': provenance.listItemId,
          },
        },
      });
    }
    const relationshipEndIndex = builder.length;
    builder.add(
      {
        Delete: {
          Key: listItemTombstone(listId, itemId),
          ConditionExpression: '#operationId = :operationId',
          ExpressionAttributeNames: { '#operationId': 'operationId' },
          ExpressionAttributeValues: { ':operationId': options.operationId },
        },
      },
      {
        Update: {
          Key: listUndo(listId, options.operationId),
          UpdateExpression:
            'SET #consumed = :true, #consumedAt = :now, #updatedAt = :now',
          ConditionExpression: '#operationId = :operationId AND #consumed = :false',
          ExpressionAttributeNames: {
            '#operationId': 'operationId',
            '#consumed': 'consumed',
            '#consumedAt': 'consumedAt',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':operationId': options.operationId,
            ':false': false,
            ':true': true,
            ':now': options.now,
          },
        },
      },
      {
        Update: {
          Key: listMeta(listId),
          UpdateExpression:
            'SET #rankVersion = :nextVersion ADD #itemCount :one, #uncheckedCount :unchecked',
          ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
          ExpressionAttributeNames: {
            '#rankVersion': 'rankVersion',
            '#itemCount': 'itemCount',
            '#uncheckedCount': 'uncheckedCount',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':expectedVersion': state.list.rankVersion,
            ':nextVersion': state.list.rankVersion + 1,
            ':one': 1,
            ':unchecked': item.checked ? 0 : 1,
          },
        },
      },
    );
    const metaIndex = builder.length - 1;
    const receiptIndex = builder.length;
    if (options.idempotencyReceipt !== undefined) {
      builder.addReserved(receiptItem(options.idempotencyReceipt));
    }
    await transactWrite(builder.build(), {
      operation: 'restoreListItem',
      onConditionFailed: (index) => {
        if (index === 0) return new ListNotFoundError();
        if (
          index === metaIndex ||
          (index >= relationshipStartIndex && index < relationshipEndIndex)
        ) {
          return new RetryableListMutationConflictError();
        }
        if (options.idempotencyReceipt !== undefined && index === receiptIndex) {
          return new IdempotencyRaceError();
        }
        return new ListUndoNotApplicableError();
      },
    });
    return item;
  });
}

export interface DeleteListOptions {
  readonly now: string;
  readonly expectedUpdatedAt: string;
  readonly sourceActivityId?: string;
  /**
   * Clears `defaultLists[slot]` on the **caller's** profile in the same transaction as the
   * META removal, conditioned on that slot still naming this list (P3-05, P3-12). The caller
   * supplies it whenever the list holds a slot — no profile pre-read decides it, because a
   * pre-read that missed a concurrent selection would wrongly skip the cleanup. A slot that
   * is absent or names another list fails only this item, and the transaction retries
   * without it, so the other value always survives.
   */
  readonly clearProfileDefault?: { readonly slot: DefaultSlot };
}

/** The profile-default item's condition failed: a newer destination choice survives. */
class StaleProfileDefaultError extends Error {
  constructor() {
    super('The profile default changed while the list was being deleted.');
    this.name = 'StaleProfileDefaultError';
  }
}

/**
 * Bounded cascade: install the tombstone/remove source projection first, delete each
 * member's roster row **atomically with** their external pointer, clear linked Activities'
 * provenance, delete the remaining child rows, then remove the owner pointer and META —
 * plus the caller's now-dangling profile default, when asked — at the authority seam.
 * Every stage is idempotent and re-discoverable, so a crashed cascade resumes from the
 * partition it can still read.
 */
export async function deleteList(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  options: DeleteListOptions,
): Promise<void> {
  assertListAccessGrant(userId, listId, access);
  const initial = new TransactionBuilder('beginDeleteList').add(
    {
      ConditionCheck: {
        Key: listMeta(listId),
        ConditionExpression: `#updatedAt = :expectedUpdatedAt AND ${GATES_ABSENT}`,
        ExpressionAttributeNames: {
          '#updatedAt': 'updatedAt',
          ...GATE_NAMES,
        },
        ExpressionAttributeValues: {
          ':expectedUpdatedAt': options.expectedUpdatedAt,
        },
      },
    },
    {
      Put: {
        Item: stamp(ENTITY.tombstone, options.now, options.now, {
          ...listTombstone(listId),
          listId,
          ownerId: userId,
          deletedAt: options.now,
          ttl: ttlFor(options.now),
        }),
        ConditionExpression: 'attribute_not_exists(pk) OR #ownerId = :ownerId',
        ExpressionAttributeNames: { '#ownerId': 'ownerId' },
        ExpressionAttributeValues: { ':ownerId': userId },
      },
    },
    ...(options.sourceActivityId === undefined
      ? []
      : [{ Delete: { Key: sourceList(options.sourceActivityId, listId) } }]),
  );
  await transactWrite(initial.build(), { operation: 'beginDeleteList' });

  const metaKey = listMeta(listId);
  const tombstoneKey = listTombstone(listId);
  const partition = await queryAll<StoredItem>(listPartition(listId), {
    consistentRead: true,
  });

  /**
   * Each member's roster row and their external pointer leave **together, atomically**, in
   * bounded chunks — never the roster row alone. The roster row is the only durable record
   * of where the pointer lives, so deleting it first and the pointer later would let a
   * crash strand a pointer no retry could rediscover; once the tombstone expires and the
   * id is reused, that stale pointer would authorise the former member against the new
   * list. Phase 3 never writes a member, but the cascade owns the shape Phase 6 inherits
   * (§P3-05, `data-model.md` §7 "Delete shared list"). An invited member has no pointer,
   * so their transaction holds the roster row alone.
   */
  const members = partition
    .filter((row) => row.entity === ENTITY.member)
    .map(parseListMember);
  const MEMBERS_PER_CHUNK = 24;
  for (let from = 0; from < members.length; from += MEMBERS_PER_CHUNK) {
    const builder = new TransactionBuilder('deleteListMembers');
    for (const member of members.slice(from, from + MEMBERS_PER_CHUNK)) {
      builder.add({ Delete: { Key: listMemberKey(listId, member.personId) } });
      if (member.status === 'active' && member.userId !== undefined) {
        builder.add({ Delete: { Key: listPointer(member.userId, listId) } });
      }
    }
    await transactWrite(builder.build(), { operation: 'deleteListMembers' });
  }

  /**
   * Every Activity a current `LNK#` pointer names has its `listId` / `listItemId`
   * back-pointers cleared — never the Activity deleted (`plans-and-lists.md` §6.3). Each
   * clear is conditional on the Activity still naming this list, so a repointed or deleted
   * Activity is skipped, and re-running the cascade after a crash converges.
   */
  const linkedActivityIds = [
    ...new Set(
      partition
        .filter((row) => row.entity === ENTITY.link)
        .map((row) => parseListItemActivityLink(row).activityId),
    ),
  ];
  for (const activityId of linkedActivityIds) {
    await clearListProvenance(activityId, listId);
  }

  // Member rows went with their pointers above; everything else but META and the
  // tombstone is unpaired and batches freely.
  const childKeys = partition
    .filter((row) => row.entity !== ENTITY.member)
    .map((row) => ({ pk: String(row.pk), sk: String(row.sk) }))
    .filter(
      (key) =>
        !(key.pk === metaKey.pk && key.sk === metaKey.sk) &&
        !(key.pk === tombstoneKey.pk && key.sk === tombstoneKey.sk),
    );
  await deleteAll(childKeys);

  let clearDefault = options.clearProfileDefault;
  for (;;) {
    const builder = new TransactionBuilder('finishDeleteList').add(
      { Delete: { Key: listPointer(userId, listId) } },
      {
        Delete: {
          Key: metaKey,
          ConditionExpression: `#updatedAt = :expectedUpdatedAt AND ${GATES_ABSENT}`,
          ExpressionAttributeNames: {
            '#updatedAt': 'updatedAt',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':expectedUpdatedAt': options.expectedUpdatedAt,
          },
        },
      },
    );
    const profileIndex = clearDefault === undefined ? -1 : builder.length;
    if (clearDefault !== undefined) {
      builder.add(removeDefaultListTransactItem(userId, clearDefault.slot, listId));
    }

    try {
      await transactWrite(builder.build(), {
        operation: 'finishDeleteList',
        onConditionFailed: (index) =>
          index === profileIndex ? new StaleProfileDefaultError() : undefined,
      });
      return;
    } catch (error) {
      // The slot is absent, or names another list — including a newer choice made on
      // another device mid-delete. That value survives; the delete retries without the item.
      if (error instanceof StaleProfileDefaultError && clearDefault !== undefined) {
        clearDefault = undefined;
        continue;
      }
      throw error;
    }
  }
}
