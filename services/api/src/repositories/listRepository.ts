import {
  MAX_AUTOMATIC_INTENT_AGE_DAYS,
  MAX_LIST_ITEMS,
  MAX_OWNED_LISTS,
} from '@od/shared';
import {
  compareListItems,
  LexoRankOverflowError,
  lexoRankBetween,
} from '@od/shared/rank';
import {
  activity as activitySchema,
  defaultSlot as defaultSlotSchema,
  instant,
  listIndex as listIndexSchema,
  listItemActivityLink as listItemActivityLinkSchema,
  listItem as listItemSchema,
  listMember as listMemberSchema,
  list as listSchema,
  type PatchListItemInput,
} from '@od/shared/schemas';
import type { Instant } from '@od/shared/time';
import type {
  Activity,
  DefaultSlot,
  ItemStateMode,
  List,
  ListFeatureConfig,
  ListIndex,
  ListItem,
  ListItemActivityLink,
  ListItemFeatures,
  ListMember,
  ListPlace,
  ListSubItem,
  ProgressValue,
  SourceListSummary,
} from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { z } from 'zod';
import { AppError } from '../lib/errors.js';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { clearListProvenance } from './activityRepository.js';
import {
  batchGetItems,
  deleteAll,
  deleteItem,
  getItem,
  type Page,
  query,
  queryAll,
  queryCount,
  updateItem,
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
  listBulkOperation,
  listItemActivityLink,
  listItemActivityLinkAllPrefix,
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
  sourceListPrefix,
} from './keys.js';
import {
  LIST_ITEM_ACTIVITY_LINK_ENTITY,
  listItemActivityLinkRow,
} from './listLinkRow.js';
import {
  hasCanonicalListShape,
  isCanonicalListRow,
  migrateListAggregateOnRead,
} from './listSchemaMigration.js';
import type { StoredItem } from './migrate.js';
import { MAX_TRANSACT_ITEMS, TransactionBuilder, transactWrite } from './tx.js';
import {
  removeDefaultListTransactItem,
  restoreDefaultListTransactItem,
} from './userRepository.js';

/**
 * The storage half of Lists and ListItems (`data-model.md` patterns 7, 8, 8b and 8d).
 *
 * This module stores rather than decides. Services resolve presets, validate typed settings,
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
  ingredientDestinationBinding: 'IngredientDestinationBinding',
  itemTombstone: 'ListItemTombstone',
  /** The one spelling lives beside the row builder both repositories share (P3-13). */
  link: LIST_ITEM_ACTIVITY_LINK_ENTITY,
  /** Written first in Phase 6; the delete cascade already iterates it (§P3-05). */
  member: 'ListMember',
  rankRepair: 'ListRankRepair',
  bulkOperation: 'ListBulkOperation',
  undo: 'ListUndo',
  tombstone: 'ListTombstone',
  sourceList: 'SourceList',
} as const;

const SCHEMA_VERSION = 2;
const PAGE_SIZE = 50;
const TABLE_KEY = ['pk', 'sk'] as const;
const MAX_MUTATION_ATTEMPTS = 5;

const GATE_NAMES = {
  '#rankRepairId': 'rankRepairId',
  '#schemaMigrationId': 'schemaMigrationId',
} as const;
const GATES_ABSENT =
  'attribute_not_exists(#rankRepairId) AND attribute_not_exists(#schemaMigrationId)';
const ITEM_VERSION_INCREMENT = 1;

/**
 * META rows created before P3-17 have no `itemVersion`. Absence is version zero; DynamoDB's
 * numeric `ADD` installs version one on their first item mutation, so no table scan or
 * stop-the-world migration is required.
 */
function itemVersion(list: List): number {
  return list.itemVersion ?? 0;
}

/** Exact snapshot condition, including the one compatible legacy state. */
function itemVersionCondition(expected: number): string {
  return expected === 0
    ? '(attribute_not_exists(#itemVersion) OR #itemVersion = :expectedItemVersion)'
    : '#itemVersion = :expectedItemVersion';
}

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

const ingredientDestinationBindingSchema = z.object({
  listId: z.string().min(1),
  requestedItemId: z.string().min(1),
  itemId: z.string().min(1),
  sourceActivityId: z.string().min(1),
  ingredientId: z.string().min(1),
  outcome: z.enum(['created', 'labelled']),
});

const itemTombstoneSchema = z.object({
  listId: z.string(),
  itemId: z.string(),
  operationId: z.string().min(1),
  snapshot: listItemSchema,
  ingredientIdentity: ingredientDestinationBindingSchema.optional(),
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
export type IngredientDestinationBinding = z.infer<
  typeof ingredientDestinationBindingSchema
>;

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

/** A public item read crossed a rank/schema generation and must be retried from page one. */
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

/**
 * The list was at its item cap when the write tried to commit.
 *
 * Raised from the transaction's own condition rather than from a read, because a service
 * precheck cannot hold: two creates against a 499-item list both pass it, and the loser
 * retries against a refreshed `rankVersion` that says nothing about capacity. The service
 * maps this to the exact `List is full.` copy.
 */
export class ListFullError extends Error {
  constructor() {
    super('The list is at its item cap.');
    this.name = 'ListFullError';
  }
}

/** A retained Undo operation no longer names a restorable tombstone. */
export class ListUndoNotApplicableError extends Error {
  constructor() {
    super('This undo is no longer applicable.');
    this.name = 'ListUndoNotApplicableError';
  }
}

/**
 * The conditional profile-default item failed: a newer destination choice survives.
 *
 * Raised by both write paths that clear `defaultLists[slot]` alongside a List write — the
 * delete cascade and a settings change of `slot` — because both must drop that one item and
 * carry on rather than fail the whole operation.
 */
class StaleProfileDefaultError extends Error {
  constructor() {
    super('The profile default changed while the list was being written.');
    this.name = 'StaleProfileDefaultError';
  }
}

/**
 * The list's rank or item generation moved between a deciding read and allocation.
 *
 * Exported, unlike its retryable sibling, because the caller has to do more than retry the
 * write: whatever it decided from the old snapshot has to be decided again (P3-17).
 */
export class ListSnapshotStaleError extends Error {
  constructor() {
    super('The list changed after it was read.');
    this.name = 'ListSnapshotStaleError';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * P3-33 briefly persisted nullable feature-patch members as item values. Those rows are still
 * otherwise canonical, so remove only the impossible null members before validation. New
 * writes never create this shape; this narrow read repair lets the affected item and its List
 * become recoverable instead of turning every exact read into `validation_failed`.
 */
function withoutLegacyNullFeatures(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.features)) return value;
  const entries = Object.entries(value.features);
  const retained = entries.filter(([, feature]) => feature !== null);
  if (retained.length === entries.length) return value;
  const repaired = { ...value };
  if (retained.length === 0) delete repaired.features;
  else repaired.features = Object.fromEntries(retained);
  return repaired;
}

function parseListItem(value: unknown): ListItem {
  return listItemSchema.parse(withoutLegacyNullFeatures(value)) as ListItem;
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

function needsAggregateRepair(row: StoredItem): boolean {
  const itemCount = row.itemCount;
  const doneCount = row.doneCount;
  return (
    typeof itemCount === 'number' &&
    Number.isInteger(itemCount) &&
    typeof doneCount === 'number' &&
    Number.isInteger(doneCount) &&
    (itemCount < 0 || doneCount < 0 || doneCount > itemCount)
  );
}

/** Rebuilds impossible counters from the strongly read live item set before parsing META. */
async function repairInvalidAggregates(
  listId: string,
  observed: StoredItem,
): Promise<StoredItem> {
  let current = observed;
  for (let attempt = 0; attempt < MAX_MUTATION_ATTEMPTS; attempt += 1) {
    if (!needsAggregateRepair(current)) return current;
    const rows = await queryAll<StoredItem>(
      { pk: listPartition(listId).pk },
      { skPrefix: listItemPrefix(listId).skPrefix, consistentRead: true },
    );
    const items = rows.map(parseListItem);
    const itemCount = items.length;
    const doneCount = items.filter((item) => item.state === 'done').length;
    const expectedItemVersion =
      typeof current.itemVersion === 'number' && Number.isInteger(current.itemVersion)
        ? current.itemVersion
        : 0;

    try {
      const repaired = await updateItem<StoredItem>(listMeta(listId), {
        expression:
          'SET #itemCount = :itemCount, #doneCount = :doneCount ADD #itemVersion :itemVersionIncrement',
        names: {
          '#itemCount': 'itemCount',
          '#doneCount': 'doneCount',
          '#itemVersion': 'itemVersion',
          ...GATE_NAMES,
        },
        values: {
          ':itemCount': itemCount,
          ':doneCount': doneCount,
          ':expectedItemCount': current.itemCount,
          ':expectedDoneCount': current.doneCount,
          ':expectedItemVersion': expectedItemVersion,
          ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
        },
        condition: `#itemCount = :expectedItemCount AND #doneCount = :expectedDoneCount AND ${itemVersionCondition(expectedItemVersion)} AND ${GATES_ABSENT}`,
      });
      if (repaired !== undefined) return repaired;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ConditionalCheckFailedException')) {
        throw error;
      }
    }

    const reread = await getItem<StoredItem>(listMeta(listId), {
      consistentRead: true,
    });
    if (reread === undefined) throw new ListNotFoundError();
    current = reread;
  }
  throw new ListReadFenceError();
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
  let row = await getItem<StoredItem>(listMeta(listId), { consistentRead: true });
  if (row === undefined) return undefined;
  const deleting = await getItem<StoredItem>(listTombstone(listId), {
    consistentRead: true,
  });
  if (deleting !== undefined) return undefined;
  // A strong fenced read must observe a marker that appeared after its first META read.
  // Draining it here would hide the generation change and require the worker row to exist
  // before `assertSameFence` can reject the page. Only legacy-shaped META needs migration;
  // canonical-shaped META remains parseable while gated.
  if (!hasCanonicalListShape(row)) row = await migrateListAggregateOnRead(listId, row);
  row = await repairInvalidAggregates(listId, row);
  return parseList(row);
}

function assertFenceOpen(list: List): void {
  if (list.rankRepairId !== undefined || list.schemaMigrationId !== undefined) {
    throw new ListReadFenceError();
  }
}

function assertSameFence(before: List, after: List): void {
  if (after.rankVersion !== before.rankVersion) {
    throw new ListReadFenceError();
  }
  assertFenceOpen(after);
}

/** P3-17 decides from fields as well as ranks, so its snapshot binds both generations. */
function assertSameItemSnapshot(before: List, after: List): void {
  assertSameFence(before, after);
  if (itemVersion(after) !== itemVersion(before)) throw new ListReadFenceError();
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
                'attribute_exists(pk) AND #ownerId = :sourceOwner AND #objectKind = :plan AND attribute_not_exists(#deletingAt)',
              ExpressionAttributeNames: {
                '#ownerId': 'ownerId',
                '#objectKind': 'objectKind',
                '#deletingAt': 'deletingAt',
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
  let row = await getItem<StoredItem>(listMeta(listId), { consistentRead: true });
  if (row === undefined) return undefined;
  if (!isCanonicalListRow(row)) row = await migrateListAggregateOnRead(listId, row);
  row = await repairInvalidAggregates(listId, row);
  return parseList(row);
}

export interface UserListEntry {
  readonly list: List;
  readonly index: ListIndex;
}

/**
 * The trimmed rows plan detail's LISTS section renders (P3-37, access pattern 4).
 *
 * One bounded `BatchGetItem` over the caller's `USER#<id>` / `LIST#<id>` pointers and the
 * corresponding `LIST#<id>` / `META` keys — never one read per List and never a Query over
 * anything. Plan participation and List membership are independent grants, so a META row is
 * emitted only when its caller-owned pointer is present in the same strong read. Results are
 * keyed back by `listId` so the caller can restore the partition's own `SOURCE_LIST#` order.
 * A missing pointer or META is simply absent from the map.
 *
 * Deliberately tolerant of the stored shape: a summary is navigation, and a legacy aggregate
 * that would fail the full parse should still name itself on the plan that made it.
 */
export async function batchGetSourceListSummaries(
  userId: string,
  listIds: readonly string[],
): Promise<Map<string, SourceListSummary>> {
  return (await batchGetDetailHydration(userId, listIds, [])).sourceLists;
}

export interface DetailBatchHydration {
  readonly sourceLists: Map<string, SourceListSummary>;
  readonly childRestoredStatuses: Map<string, 'saved' | 'scheduled'>;
}

/**
 * The one third-round-trip batch for Plan detail: caller/List grants + List META and the
 * canonical child META rows needed only by additive legacy pointers. Keeping both key sets in
 * one BatchGet preserves the endpoint's three-round-trip budget without an N+1 fallback.
 */
export async function batchGetDetailHydration(
  userId: string,
  listIds: readonly string[],
  legacyChildActivityIds: readonly string[],
): Promise<DetailBatchHydration> {
  const unique = [...new Set(listIds)];
  const uniqueChildren = [...new Set(legacyChildActivityIds)];
  if (unique.length === 0 && uniqueChildren.length === 0) {
    return { sourceLists: new Map(), childRestoredStatuses: new Map() };
  }
  const rows = await batchGetItems<StoredItem>(
    [
      ...unique.flatMap((listId) => [listPointer(userId, listId), listMeta(listId)]),
      ...uniqueChildren.map(activityMeta),
    ],
    { consistentRead: true },
  );
  const requested = new Set(unique);
  const authorized = new Set<string>();
  for (const row of rows) {
    if (row.entity !== ENTITY.index || typeof row.listId !== 'string') continue;
    if (!requested.has(row.listId)) continue;
    const expected = listPointer(userId, row.listId);
    if (row.pk === expected.pk && row.sk === expected.sk) authorized.add(row.listId);
  }
  const summaries = new Map<string, SourceListSummary>();
  const requestedChildren = new Set(uniqueChildren);
  const childRestoredStatuses = new Map<string, 'saved' | 'scheduled'>();
  for (const row of rows) {
    if (row.entity === 'Activity') {
      const child = activitySchema.safeParse(row);
      if (child.success && requestedChildren.has(child.data.activityId)) {
        childRestoredStatuses.set(
          child.data.activityId,
          child.data.schedule === undefined ? 'saved' : 'scheduled',
        );
      }
      continue;
    }
    if (row.entity !== ENTITY.list) continue;
    const listId = typeof row.listId === 'string' ? row.listId : undefined;
    const title = typeof row.title === 'string' ? row.title : undefined;
    if (listId === undefined || title === undefined || !authorized.has(listId)) continue;
    summaries.set(listId, {
      listId,
      title,
      icon: typeof row.icon === 'string' ? row.icon : 'list',
      itemCount: typeof row.itemCount === 'number' ? row.itemCount : 0,
      doneCount: typeof row.doneCount === 'number' ? row.doneCount : 0,
    });
  }
  return { sourceLists: summaries, childRestoredStatuses };
}

/** One model-bounded strong page of id-only source-list projections. */
export async function listSourceListIds(activityId: string): Promise<string[]> {
  const prefix = sourceListPrefix(activityId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: MAX_OWNED_LISTS,
      consistentRead: true,
    },
  );
  return page.items
    .filter((row) => row.entity === ENTITY.sourceList && typeof row.listId === 'string')
    .map((row) => String(row.listId));
}

/**
 * Pattern 7: one pointer Query and one META BatchGet, restored to pointer order.
 *
 * ## `consistentRead`, and why it is a parameter
 *
 * Off by default, which is right for `GET /v1/lists`: browsing an index a fraction of a
 * second behind is invisible, and a strong read costs twice the capacity on the one endpoint
 * a client hits most.
 *
 * **Slot resolution asks for it on** (P3-12). Eligibility is not a rendering decision, it is
 * a destination decision, and every part of it turns on state the user may have changed a
 * moment ago: a list archived seconds earlier is still a candidate to a stale read; a
 * membership just revoked still yields a pointer to a list the caller can no longer write to;
 * and "exactly one" versus "several" — which is the difference between using a list silently
 * and asking — turns on a pointer that may have only just been created or removed. The read
 * fences the whole set, both halves, because a strong pointer Query paired with a stale META
 * read would still see a list as unarchived after the user archived it.
 */
export async function listListsForUser(
  userId: string,
  cursor?: string,
  options: { readonly consistentRead?: boolean } = {},
): Promise<Page<UserListEntry>> {
  const prefix = listPointerPrefix(userId);
  const strong = options.consistentRead === true ? { consistentRead: true } : {};
  const pointerPage = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      limit: PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor }),
      keyAttributes: TABLE_KEY,
      ...strong,
    },
  );
  const pointers = pointerPage.items.map(parseListIndex);
  const rows = await batchGetItems<StoredItem>(
    pointers.flatMap((pointer) => [
      listMeta(pointer.listId),
      listTombstone(pointer.listId),
    ]),
    strong,
  );
  const listRows = rows.filter((row) => row.entity === ENTITY.list);
  const migratedRows = await Promise.all(
    listRows.map(async (row) => {
      const listId = String(row.listId);
      const canonical = isCanonicalListRow(row)
        ? row
        : await migrateListAggregateOnRead(listId, row);
      return repairInvalidAggregates(listId, canonical);
    }),
  );
  const lists = new Map(
    migratedRows.map((row) => {
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

/**
 * Every viewer's pointer that currently names this Activity for this item (P3-15).
 *
 * Two lifecycle rows need it: a Plan skipped, and a Plan deleted. Both say "clear the
 * pointers **to that Plan**" — not every pointer on the item, because a different viewer may
 * have planned the same item independently and their Plan is untouched by what happened to
 * this one (ADR-034).
 *
 * The sort key orders viewer before item, so this reads the list's bounded `LNK#` prefix and
 * filters rather than seeking. That ordering is right for the read that happens constantly —
 * one viewer's own rows — and this one happens on a skip or a delete.
 *
 * Returns the observed rows rather than keys, so the caller's delete can condition on the
 * exact `activityId` it saw and lose to any newer pointer.
 */
export async function findViewerLinksTo(
  listId: string,
  itemId: string,
  activityId: string,
): Promise<ListItemActivityLink[]> {
  const prefix = listItemActivityLinkAllPrefix(listId);
  const rows = await queryAll<StoredItem>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix, consistentRead: true },
  );
  return rows
    .map((row) => parseListItemActivityLink(row))
    .filter((link) => link.itemId === itemId && link.activityId === activityId);
}

/**
 * Removes one viewer's pointer, but **only while it is still byte-for-byte the row the read
 * found unreadable** (P3-14, `api-contract.md` §3).
 *
 * The condition is the whole safety of this. The projection decides a pointer is stale, then
 * deletes it a moment later, and anything at all may have happened in between.
 *
 * It matches on `activityId` **and** `linkedAt`, not `activityId` alone. Both change when the
 * viewer schedules a different Plan, but only `linkedAt` changes when the pointer is rewritten
 * to the *same* Activity — which is exactly what re-adding a viewer to a Plan they had lost
 * access to does. On `activityId` alone that refreshed, valid pointer still matched the
 * condition and was deleted, crossing the sharing boundary `security-privacy.md` row 15a
 * protects. Matching the pair means **any** rewrite wins and the cleanup loses, which is the
 * right way round: a pointer that should have gone will be caught by the next read, while one
 * deleted in error is gone for good.
 *
 * Idempotent by construction: deleting an absent row is a no-op, and a second pass over the
 * same stale pointer finds nothing to remove.
 */
export async function deleteStaleViewerLink(
  listId: string,
  viewerUserId: string,
  itemId: string,
  observed: Pick<ListItemActivityLink, 'activityId' | 'linkedAt'>,
): Promise<void> {
  await deleteItem(listItemActivityLink(listId, viewerUserId, itemId), {
    expression: '#activityId = :activityId AND #linkedAt = :linkedAt',
    names: { '#activityId': 'activityId', '#linkedAt': 'linkedAt' },
    values: { ':activityId': observed.activityId, ':linkedAt': observed.linkedAt },
  });
}

interface ResolvedItem {
  readonly item: ListItem;
  readonly locator: Locator;
  readonly row: StoredItem;
  readonly ingredientIdentity?: IngredientDestinationBinding;
}

async function resolveItemStrong(
  listId: string,
  itemId: string,
): Promise<ResolvedItem | undefined> {
  const locatorRow = await getItem<StoredItem>(listItemLocator(listId, itemId), {
    consistentRead: true,
  });
  if (locatorRow === undefined) return undefined;
  const parsedLocator = locatorSchema.safeParse(locatorRow);
  // An absorbed ingredient destination occupies the authoritative ITEMID namespace but is
  // not itself an addressable ListItem. Exact item routes therefore treat the alias as absent.
  if (!parsedLocator.success) return undefined;
  const locator = parsedLocator.data;
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
  const ingredientIdentity = ingredientDestinationBindingSchema.safeParse(locatorRow);
  return {
    item,
    locator,
    row,
    ...(ingredientIdentity.success
      ? { ingredientIdentity: ingredientIdentity.data }
      : {}),
  };
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

/** What a completed watch session needs in order to describe a follow-up (P3-16). */
export interface WatchFollowUpSource {
  readonly list: List;
  readonly link: ListItemActivityLink;
  readonly item: ListItem;
}

/**
 * The list, the caller's own pointer and the exact item, read together under one fence
 * (access pattern 8f).
 *
 * ## Why this is one read and not three existing ones
 *
 * Composing `getListMeta`, `batchGetViewerLinks` and `getListItem` would answer the same
 * question — and would take three independent pre/post fences to do it, roughly thirteen
 * round trips hung off a completion that is already several reads deep. Worse, three fences
 * is three *different* fences: the pointer could be read under one `rankVersion` and the
 * item under the next, which is precisely the mixed generation each fence exists to refuse.
 *
 * One fence, and the three keyed reads inside it issued together. The suggestion is either
 * a consistent picture of one list or it is not offered.
 *
 * ## What the fence is protecting here
 *
 * The schema-migration edge case: a legacy watch aggregate is converted a page at a time.
 * Mid-migration the rows are a mix of both shapes, so an unfenced read could find legacy
 * watch progress on a row the migration has not reached yet.
 *
 * A missing List, no compatible exposed state/Progress, a missing pointer and a missing item are all
 * `undefined` — one absent thing among four, with nothing to tell apart. A fence failure
 * still **throws** `ListReadFenceError`, as it does at every other call site rather than
 * being quietly special here; turning that into "no follow-up" is the caller's policy
 * decision and is made in the service, where it can be read next to the rest of the rule.
 */
export async function readWatchFollowUpSource(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
): Promise<WatchFollowUpSource | undefined> {
  assertListAccessGrant(userId, listId, access);
  const before = await getLiveListMetaStrong(listId);
  if (before === undefined) return undefined;
  assertFenceOpen(before);
  const episodeProgressEnabled =
    before.featureConfig.progress?.enabled === true &&
    before.featureConfig.progress.kind === 'episode';
  if (!episodeProgressEnabled && before.itemStateMode.mode === 'none') return undefined;

  const [linkRow, resolved] = await Promise.all([
    getItem<StoredItem>(listItemActivityLink(listId, userId, itemId), {
      consistentRead: true,
    }),
    resolveItemStrong(listId, itemId),
  ]);

  const after = await getLiveListMetaStrong(listId);
  if (after === undefined) return undefined;
  assertSameFence(before, after);

  if (linkRow === undefined || resolved === undefined) return undefined;
  return {
    list: after,
    link: parseListItemActivityLink(linkRow),
    item: resolved.item,
  };
}

/**
 * Every item on one list, unpaged (access pattern 8e).
 *
 * The bounded whole-list read a worker or a confirmation preview needs and a response never
 * does: it is capped by `MAX_LIST_ITEMS`, so `queryAll` is safe, and it returns rows rather
 * than a page, so nothing about it is resumable. Unlike the worker's own unfenced snapshot it
 * **requires the fence open**, because its caller is a public request deciding what to tell
 * the user — a count taken across a running migration would be a count of a list in two
 * shapes at once.
 */
export async function readAllListItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
): Promise<ListItem[]> {
  assertListAccessGrant(userId, listId, access);
  const list = await getLiveListMetaStrong(listId);
  if (list === undefined) throw new ListNotFoundError();
  assertFenceOpen(list);
  return readAllItemsUnfenced(listId);
}

/** Every item on one list, and both generations they were read under (P3-17). */
export interface ListItemSnapshot {
  readonly items: ListItem[];
  readonly ingredientDestinationBindings: ReadonlyMap<
    string,
    IngredientDestinationBinding
  >;
  /**
   * Requested destination ids that a retained `ITEM_TOMBSTONE#` still owns.
   *
   * A deleted item keeps its id reserved for the replay window so its own Undo can put the
   * row back, and **only that Undo may reclaim it** (§P3-10, §P3-17). The create path has
   * always enforced this with a per-row `ConditionCheck`; the binding path writes to the same
   * `ITEMID#` key and could not, so this read is where the rule is applied for both.
   */
  readonly tombstonedDestinationIds: ReadonlySet<string>;
  readonly rankVersion: number;
  readonly itemVersion: number;
}

/**
 * Pattern 8e's read, with the pre/post fence that lets the caller **decide** from it.
 *
 * ## Why this is not {@link readAllListItems}
 *
 * That one answers "what is on this list", which is all its three callers need — a data-loss
 * count and an Undo filter, both of which only report. P3-17 does something else with the
 * same rows: it classifies each ingredient against them, and then **writes** on the strength
 * of that classification. A read that only reports may be a moment stale; a read that decides
 * may not.
 *
 * So this returns both `rankVersion` and the storage-only `itemVersion`, and requires both
 * unchanged across the item query. Those are then the generations the caller's transaction
 * must commit under, which makes both "no matching row exists" and "no row was renamed into
 * this title" claims the transaction can actually enforce.
 *
 * **This closes a real hole** (raised in review). The service used to snapshot here and read
 * `rankVersion` again inside rank allocation, so a concurrent create landing between the two
 * was adopted by the later read. Binding rank generation closed that hole; `itemVersion`
 * closes the corresponding field-only rename/check/delete hole without invalidating ordinary
 * item-page cursors on every checkbox tap.
 *
 * Left as a separate function rather than folded into `readAllListItems` because the stricter
 * fence would newly reject the other three callers' reads on an unrelated concurrent create,
 * and making a *count* fail because someone else added a row is not an improvement.
 */
export async function snapshotListItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  requestedIngredientDestinationIds: readonly string[] = [],
): Promise<ListItemSnapshot> {
  assertListAccessGrant(userId, listId, access);
  const before = await getLiveListMetaStrong(listId);
  if (before === undefined) throw new ListNotFoundError();
  assertFenceOpen(before);

  const requestedIds = [...new Set(requestedIngredientDestinationIds)];
  /**
   * Both rows a requested destination id can already be spoken for by, read under the same
   * fence as the items: the locator (a live row, or an absorbed binding) and the tombstone
   * (a deleted row's reserved id). Two keys per id, so the 30-ingredient cap keeps this at
   * 60 — inside `BatchGetItem`'s hundred.
   */
  const tombstoneKeys = new Map(
    requestedIds.map((requestedItemId) => [
      requestedItemId,
      listItemTombstone(listId, requestedItemId),
    ]),
  );
  const [items, requestedRows] = await Promise.all([
    readAllItemsUnfenced(listId),
    batchGetItems<StoredItem>(
      requestedIds.flatMap((requestedItemId) => [
        listItemLocator(listId, requestedItemId),
        listItemTombstone(listId, requestedItemId),
      ]),
      { consistentRead: true },
    ),
  ]);

  const after = await getLiveListMetaStrong(listId);
  if (after === undefined) throw new ListNotFoundError();
  assertSameItemSnapshot(before, after);
  return {
    items,
    ingredientDestinationBindings: new Map(
      requestedRows.flatMap((row) => {
        const binding = ingredientDestinationBindingSchema.safeParse(row);
        return binding.success
          ? ([[binding.data.requestedItemId, binding.data]] as const)
          : [];
      }),
    ),
    tombstonedDestinationIds: new Set(
      [...tombstoneKeys].flatMap(([requestedItemId, key]) =>
        requestedRows.some((row) => row.pk === key.pk && row.sk === key.sk)
          ? [requestedItemId]
          : [],
      ),
    ),
    rankVersion: after.rankVersion,
    itemVersion: itemVersion(after),
  };
}

export interface ListMetaPatch {
  readonly title?: string;
  readonly itemStateMode?: ItemStateMode;
  readonly featureConfig?: ListFeatureConfig;
  readonly slot?: List['slot'];
  readonly archived?: boolean;
}

/** The exact profile default a forward settings change removed, for its inverse. */
export interface RemovedListDefault {
  readonly slot: DefaultSlot;
  readonly listId: string;
}

/**
 * What an Undo of one additive settings operation would write back
 * (`data-model.md` §3.3, §7 "Undo List operation").
 *
 * Only fields the forward change actually altered are present, so compensation restores what
 * was touched and nothing else. Every effective setting, including title, receives the same
 * six-second Undo offer.
 */
export interface ListSettingsInverse {
  readonly title?: string;
  readonly itemStateMode?: ItemStateMode;
  readonly featureConfig?: ListFeatureConfig;
  readonly slot?: DefaultSlot | null;
  readonly archived?: boolean;
  /** Restored only while nothing newer occupies that slot (P3-12). */
  readonly removedDefault?: RemovedListDefault;
}

/**
 * What must still be true for the inverse above to apply.
 *
 * Recorded rather than re-derived, because "unchanged" means unchanged **since this
 * operation**, and only this operation knows what it wrote. P3-10 condition-checks these and
 * returns the typed no-longer-applicable result, writing nothing, when any has moved on.
 */
export interface ListSettingsPreconditions {
  readonly title?: string;
  readonly itemStateMode?: ItemStateMode;
  readonly featureConfig?: ListFeatureConfig;
  readonly slot?: DefaultSlot | null;
  readonly archived?: boolean;
  /**
   * §P3-09's "the exact default fields that operation created": every affected item's
   * `details` must still deep-equal this, or an intervening edit has made the inverse no
   * longer applicable. Absent means the forward change removed `details` and the items must
   * still have none.
   */
  /** The profile slot the forward change emptied must still be empty. */
  readonly defaultSlotAbsent?: DefaultSlot;
}

/** One retained, single-use settings Undo operation, minted by the service that wrote it. */
export interface ListSettingsUndo {
  readonly operationId: string;
  readonly kind: 'settings';
  /** Only the hash enters this retained Undo row; the exact-response receipt is separate. */
  readonly tokenHash: string;
  readonly undoExpiresAt: string;
  readonly inverse: ListSettingsInverse;
  readonly preconditions: ListSettingsPreconditions;
}

const settingsInverseSchema = z.object({
  title: z.string().min(1).optional(),
  itemStateMode: z.unknown().optional(),
  featureConfig: z.unknown().optional(),
  slot: defaultSlotSchema.nullable().optional(),
  archived: z.boolean().optional(),
  removedDefault: z
    .object({ slot: defaultSlotSchema, listId: z.string().min(1) })
    .optional(),
});

const settingsPreconditionsSchema = z.object({
  title: z.string().min(1).optional(),
  itemStateMode: z.unknown().optional(),
  featureConfig: z.unknown().optional(),
  slot: defaultSlotSchema.nullable().optional(),
  archived: z.boolean().optional(),
  defaultSlotAbsent: defaultSlotSchema.optional(),
});

/** Every kind of compensation one retained operation can carry (`data-model.md` §3.3). */
export type ListUndoKind = 'delete_item' | 'clear_done' | 'reopen_done' | 'settings';

export interface ListUndoOperation {
  readonly listId: string;
  readonly operationId: string;
  readonly kind: ListUndoKind;
  readonly tokenHash: string;
  /** The **UI** offer deadline. Never consulted when deciding whether an inverse may run. */
  readonly undoExpiresAt: string;
  readonly affectedItemIds: readonly string[];
  /** First accepted compensation instant, reused if a chunked inverse resumes. */
  readonly acceptedAt?: Instant;
  /** Compensation rows committed before this request, preserved across process restarts. */
  readonly completedCount: number;
  readonly inverse?: ListSettingsInverse;
  readonly preconditions?: ListSettingsPreconditions;
  readonly consumed: boolean;
  /** Epoch seconds. The **replay** retention, and the only expiry that refuses an inverse. */
  readonly ttl: number;
}

const listUndoSchema = z.object({
  listId: z.string().min(1),
  operationId: z.string().min(1),
  kind: z.enum(['delete_item', 'clear_done', 'reopen_done', 'settings']),
  tokenHash: z.string().min(1),
  undoExpiresAt: z.string().min(1),
  affectedItemIds: z.array(z.string().min(1)).default([]),
  acceptedAt: instant.optional(),
  completedCount: z.number().int().nonnegative().default(0),
  inverse: settingsInverseSchema.optional(),
  preconditions: settingsPreconditionsSchema.optional(),
  consumed: z.boolean(),
  ttl: z.number().int(),
});

/**
 * One retained operation, addressed by the id its token carries (P3-10).
 *
 * Deliberately **not** filtered by `consumed` or by retention here: the compensation service
 * has to tell "already used" from "never existed" to answer with the right typed outcome, and
 * a repository that hid both behind `undefined` would collapse them.
 */
export async function getListUndoOperation(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  operationId: string,
): Promise<ListUndoOperation | undefined> {
  assertListAccessGrant(userId, listId, access);
  const row = await getItem<StoredItem>(listUndo(listId, operationId), {
    consistentRead: true,
  });
  if (row === undefined) return undefined;
  const parsed = listUndoSchema.parse(row);
  return parsed.listId === listId ? (parsed as ListUndoOperation) : undefined;
}

export interface ListUndoAcceptance {
  readonly acceptedAt: Instant;
  readonly completedCount: number;
}

/** Persists the first acceptance instant and returns resumable compensation progress. */
export async function acceptListUndoOperation(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  operationId: string,
  now: Instant,
): Promise<ListUndoAcceptance> {
  assertListAccessGrant(userId, listId, access);
  try {
    const row = await updateItem<StoredItem>(listUndo(listId, operationId), {
      expression: 'SET #acceptedAt = if_not_exists(#acceptedAt, :now)',
      names: {
        '#acceptedAt': 'acceptedAt',
        '#operationId': 'operationId',
        '#consumed': 'consumed',
      },
      values: { ':now': now, ':operationId': operationId, ':false': false },
      condition: '#operationId = :operationId AND #consumed = :false',
    });
    if (row === undefined) throw new ListUndoNotApplicableError();
    const accepted = listUndoSchema.parse(row);
    const acceptedAt = accepted.acceptedAt;
    if (acceptedAt === undefined)
      throw new Error('Undo acceptance timestamp was not stored.');
    return { acceptedAt, completedCount: accepted.completedCount };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new ListUndoNotApplicableError();
    }
    throw error;
  }
}

function settingsUndoItem(
  listId: string,
  undo: ListSettingsUndo,
  now: string,
): StoredItem {
  return stamp(ENTITY.undo, now, now, {
    ...listUndo(listId, undo.operationId),
    listId,
    operationId: undo.operationId,
    kind: undo.kind,
    tokenHash: undo.tokenHash,
    undoExpiresAt: undo.undoExpiresAt,
    inverse: undo.inverse,
    preconditions: undo.preconditions,
    ttl: ttlFor(now),
    consumed: false,
  });
}

export interface PatchListMetaOptions {
  /**
   * Removes `defaultLists[slot]` from the **caller's** profile in the same transaction,
   * conditioned on that slot still naming this list — the identical conditional nested
   * removal list deletion uses, and deliberately the same helper (P3-05, P3-12). The caller
   * supplies it whenever it is replacing a slot this list could be the default for; no
   * profile pre-read decides it, because a read that missed a concurrent selection would
   * wrongly skip the cleanup.
   */
  readonly clearProfileDefault?: { readonly slot: DefaultSlot };
  /**
   * Builds the Undo record **after** it is known whether the profile default was actually
   * removed, for `createListItems`'s reason: the stored inverse must describe what this
   * transaction really wrote. A destination chosen concurrently on another device fails only
   * that item, the write retries without it, and the inverse must then not claim to have
   * removed a default it left standing.
   */
  readonly undoFor?: (removedDefault?: RemovedListDefault) => ListSettingsUndo;
  /** Replay receipt for the durable settings PATCH. */
  readonly idempotencyReceipt?: IdempotencyReceipt;
}

/**
 * One conditional META Update; renaming therefore writes exactly one item.
 *
 * With a slot removal or an Undo record it becomes a transaction of at most four, and still
 * exactly one `List` row: the profile item is another partition, the Undo row is internal
 * work state, and the first entry is the deletion gate every list-partition write carries.
 *
 * **It does not read the row back.** The update is conditional on the exact `updatedAt` it
 * is replacing, so the committed post-image is the pre-image with these fields applied and
 * nothing else — the caller already holds both halves. Re-reading would cost two more strong
 * reads (`META` and the deletion tombstone) on every settings change to learn something the
 * condition already guarantees.
 */
export async function patchListMeta(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  patch: ListMetaPatch,
  expectedUpdatedAt: string,
  updatedAt: string,
  options: PatchListMetaOptions = {},
): Promise<void> {
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

  for (const field of [
    'title',
    'itemStateMode',
    'featureConfig',
    'slot',
    'archived',
  ] as const) {
    if (!(field in patch)) continue;
    names[`#${field}`] = field;
    values[`:${field}`] = patch[field];
    sets.push(`#${field} = :${field}`);
  }

  let clearDefault = options.clearProfileDefault;
  for (;;) {
    const removedDefault =
      clearDefault === undefined ? undefined : { slot: clearDefault.slot, listId };
    const builder = new TransactionBuilder(
      'patchListMeta',
      options.idempotencyReceipt === undefined ? 0 : 1,
    ).add(listDeletionGate(listId), {
      Update: {
        Key: listMeta(listId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: `#updatedAt = :expectedUpdatedAt AND ${GATES_ABSENT}`,
      },
    });
    if (options.undoFor !== undefined) {
      builder.add({
        Put: {
          Item: settingsUndoItem(listId, options.undoFor(removedDefault), updatedAt),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }
    const profileIndex = clearDefault === undefined ? -1 : builder.length;
    if (clearDefault !== undefined) {
      builder.add(removeDefaultListTransactItem(userId, clearDefault.slot, listId));
    }
    const receiptIndex = builder.length;
    if (options.idempotencyReceipt !== undefined) {
      builder.addReserved(receiptItem(options.idempotencyReceipt));
    }

    try {
      await transactWrite(builder.build(), {
        operation: 'patchListMeta',
        onConditionFailed: (index) => {
          if (index === 0) return new ListNotFoundError();
          if (index === receiptIndex && options.idempotencyReceipt !== undefined) {
            return new IdempotencyRaceError();
          }
          return index === profileIndex ? new StaleProfileDefaultError() : undefined;
        },
      });
      return;
    } catch (error) {
      /**
       * The slot is absent, or names another list — including a newer destination chosen on
       * another device between this caller's read and this write. That choice survives: the
       * settings change retries without the item, and `undoFor` rebuilds the inverse so it
       * cannot claim to have removed a default that is still standing.
       */
      if (error instanceof StaleProfileDefaultError && clearDefault !== undefined) {
        clearDefault = undefined;
        continue;
      }
      throw error;
    }
  }
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

function storedLocator(
  item: ListItem,
  now: string,
  ingredientIdentity?: IngredientDestinationBinding,
): StoredItem {
  if (
    ingredientIdentity !== undefined &&
    (ingredientIdentity.requestedItemId !== item.itemId ||
      ingredientIdentity.itemId !== item.itemId)
  ) {
    throw new Error('A created item locator may carry only its own ingredient identity.');
  }
  return stamp(ENTITY.locator, now, now, {
    ...listItemLocator(item.listId, item.itemId),
    listId: item.listId,
    itemId: item.itemId,
    rank: item.rank,
    itemRevision: item.itemRevision,
    ...ingredientIdentity,
  });
}

/**
 * Delegates to the shared builder (P3-13). The bridge writes this same row inside the
 * Activity-create transaction, and a second construction here would be the same row spelled
 * twice — the shape that drifts the first time a field is added.
 */
function storedListItemActivityLink(link: ListItemActivityLink, now: string): StoredItem {
  return listItemActivityLinkRow(link, now);
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
 * The canonical item for each of these ids that already exists.
 *
 * The post-receipt replay guard for bulk (§P3-08): once the 24-hour receipt has expired,
 * replay protection falls to the stable client-minted ids, so a replay resolves what is
 * already committed, writes only the remainder, and answers with **server truth for every
 * requested identity** rather than only the rows this attempt happened to write.
 *
 * It returns the items rather than the ids because a replay's response has to reconcile:
 * a client that lost the original response needs the stored rank and fields, not the
 * knowledge that something exists.
 *
 * A tombstoned id has no locator and is deliberately **absent**: an ordinary create must
 * still fail against its tombstone, which is P3-10's restore path's to reclaim.
 */
export async function resolveExistingItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemIds: readonly string[],
): Promise<Map<string, ListItem>> {
  assertListAccessGrant(userId, listId, access);
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return new Map();

  const locatorRows = await batchGetItems<StoredItem>(
    uniqueIds.map((itemId) => listItemLocator(listId, itemId)),
    { consistentRead: true },
  );
  // Absorbed ingredient aliases deliberately occupy ITEMID too. They block an ordinary
  // create but do not masquerade as an ordinary bulk replay of a differently identified row.
  const locators = locatorRows.flatMap((row) => {
    const parsed = locatorSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  if (locators.length === 0) return new Map();

  const itemRows = await batchGetItems<StoredItem>(
    locators.map((locator) => listItemKey(listId, locator.rank, locator.itemId)),
    { consistentRead: true },
  );
  return new Map(
    itemRows.map((row) => {
      const item = parseListItem(row);
      return [item.itemId, item] as const;
    }),
  );
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
/**
 * What a composed multi-item list write needs to know before it can build its transaction:
 * the fenced List, and ranks allocated from neighbours read under that fence.
 */
export interface ListWriteBasis {
  readonly list: List;
  readonly ranks: readonly string[];
}

/**
 * Allocates ranks for `count` new rows under the current fence, without writing.
 *
 * Split out of {@link createListItems} so a caller that must commit list rows **and** rows in
 * another partition in one transaction can still get its ranks from exactly the same
 * neighbours-under-a-version read (P3-17). The alternative was a second rank allocator, which
 * is how two callers eventually disagree about what a valid rank is.
 *
 * ## Expected snapshot generations, and why they are not optional in spirit
 *
 * This function reads the META generations used by the caller's transaction. A caller that
 * **decided something** from an earlier read — P3-17 classifies each ingredient against a
 * {@link snapshotListItems} snapshot — must commit under *those* generations, not whatever
 * this read happens to find. `rankVersion` covers structural writes; storage-only
 * `itemVersion` covers field patches and deletes without making public page cursors churn.
 *
 * A caller with a snapshot passes both and gets {@link ListSnapshotStaleError} if either has
 * moved. Callers with nothing to preserve omit them and take current truth, as before.
 */
export async function planListItemWrites(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  count: number,
  options: {
    readonly afterItemId?: string | null;
    readonly expectedRankVersion?: number;
    readonly expectedItemVersion?: number;
  } = {},
): Promise<ListWriteBasis> {
  assertListAccessGrant(userId, listId, access);
  const state = await readMutationState(userId, listId, access);
  if (
    (options.expectedRankVersion !== undefined &&
      state.list.rankVersion !== options.expectedRankVersion) ||
    (options.expectedItemVersion !== undefined &&
      itemVersion(state.list) !== options.expectedItemVersion)
  ) {
    throw new ListSnapshotStaleError();
  }
  const neighbours = await readNeighbours(listId, options.afterItemId);
  return { list: state.list, ranks: count === 0 ? [] : allocateRanks(neighbours, count) };
}

/** Where each class of condition failure sits, so a caller can name the right error. */
export interface ListItemCreateSpans {
  readonly deletionGate: number;
  /** Item/locator/tombstone conditions occupy `[deletionGate + 1, meta)`. */
  readonly meta: number;
}

/**
 * Appends the create half of a list-item write to a caller-owned transaction.
 *
 * The conditions are {@link createListItems}' own, unchanged: `attribute_not_exists` on both
 * the ranked row and its locator, a tombstone absence check per item, and the META update
 * that advances `rankVersion` and `itemVersion`, moves the counters and **enforces the cap in
 * transaction** — a service precheck is never a cap, because the retry re-reads
 * `rankVersion` and learns nothing about capacity.
 */
export function appendListItemCreates(
  builder: TransactionBuilder,
  listId: string,
  created: readonly ListItem[],
  basis: ListWriteBasis,
  now: string,
  ingredientIdentities: ReadonlyMap<string, IngredientDestinationBinding> = new Map(),
): ListItemCreateSpans {
  const deletionGate = builder.length;
  builder.add(listDeletionGate(listId));
  for (const item of created) {
    builder.add(
      {
        Put: {
          Item: storedListItem(item, now),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      {
        Put: {
          Item: storedLocator(item, now, ingredientIdentities.get(item.itemId)),
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

  const meta = builder.length;
  const done = created.filter((item) => item.state === 'done').length;
  builder.add({
    Update: {
      Key: listMeta(listId),
      UpdateExpression:
        'SET #rankVersion = :nextVersion, #itemCount = #itemCount + :count, #doneCount = #doneCount + :done, #lastItemActivityAt = :lastItemActivityAt ADD #itemVersion :itemVersionIncrement',
      ConditionExpression: `#rankVersion = :expectedVersion AND ${itemVersionCondition(itemVersion(basis.list))} AND #itemCount <= :maxBefore AND ${GATES_ABSENT}`,
      ExpressionAttributeNames: {
        '#rankVersion': 'rankVersion',
        '#itemVersion': 'itemVersion',
        '#itemCount': 'itemCount',
        '#doneCount': 'doneCount',
        '#lastItemActivityAt': 'lastItemActivityAt',
        ...GATE_NAMES,
      },
      ExpressionAttributeValues: {
        ':lastItemActivityAt': now,
        ':expectedVersion': basis.list.rankVersion,
        ':nextVersion': basis.list.rankVersion + 1,
        ':expectedItemVersion': itemVersion(basis.list),
        ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
        ':count': created.length,
        ':done': done,
        ':maxBefore': MAX_LIST_ITEMS - created.length,
      },
    },
  });
  return { deletionGate, meta };
}

/**
 * Appends a `sourceLabel` extension for one already-read row (P3-17).
 *
 * The P3-17 caller composes these writes with the one META/version update, creates, source
 * markers and receipt. Conditioned on the `itemRevision` the caller read, which is what makes
 * the non-`done` classification behind the extension safe: the revision moves when `state`
 * does, so a row completed in between fails here rather than being extended when §7.3 says it
 * should have become a new row.
 */
export function appendSourceLabelExtension(
  builder: TransactionBuilder,
  listId: string,
  current: ListItem,
  next: ListItem,
  now: string,
  ingredientIdentity?: IngredientDestinationBinding,
): void {
  if (
    next.sourceActivityId === undefined ||
    next.sourceLabel === undefined ||
    next.sourceProvenance === undefined
  ) {
    throw new Error(
      'A provenance extension must carry its rendered and structured forms.',
    );
  }
  if (
    ingredientIdentity !== undefined &&
    (ingredientIdentity.requestedItemId !== current.itemId ||
      ingredientIdentity.itemId !== current.itemId)
  ) {
    throw new Error('A locator extension may carry only its own ingredient identity.');
  }
  builder.add(
    {
      Update: {
        Key: listItemKey(listId, current.rank, current.itemId),
        UpdateExpression:
          'SET #sourceActivityId = :sourceActivityId, #sourceLabel = :sourceLabel, #sourceProvenance = :sourceProvenance, #itemRevision = :nextRevision, #updatedAt = :updatedAt',
        ConditionExpression: '#itemRevision = :expectedRevision',
        ExpressionAttributeNames: {
          '#sourceActivityId': 'sourceActivityId',
          '#sourceLabel': 'sourceLabel',
          '#sourceProvenance': 'sourceProvenance',
          '#itemRevision': 'itemRevision',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':sourceActivityId': next.sourceActivityId,
          ':sourceLabel': next.sourceLabel,
          ':sourceProvenance': next.sourceProvenance,
          ':expectedRevision': current.itemRevision,
          ':nextRevision': current.itemRevision + 1,
          ':updatedAt': now,
        },
      },
    },
    {
      Update: {
        Key: listItemLocator(listId, current.itemId),
        UpdateExpression:
          ingredientIdentity === undefined
            ? 'SET #itemRevision = :nextRevision, #updatedAt = :updatedAt'
            : 'SET #itemRevision = :nextRevision, #updatedAt = :updatedAt, #requestedItemId = :requestedItemId, #sourceActivityId = :sourceActivityId, #ingredientId = :ingredientId, #outcome = :outcome',
        ConditionExpression:
          ingredientIdentity === undefined
            ? '#rank = :rank AND #itemRevision = :expectedRevision'
            : '#rank = :rank AND #itemRevision = :expectedRevision AND attribute_not_exists(#ingredientId)',
        ExpressionAttributeNames: {
          '#rank': 'rank',
          '#itemRevision': 'itemRevision',
          '#updatedAt': 'updatedAt',
          ...(ingredientIdentity === undefined
            ? {}
            : {
                '#requestedItemId': 'requestedItemId',
                '#sourceActivityId': 'sourceActivityId',
                '#ingredientId': 'ingredientId',
                '#outcome': 'outcome',
              }),
        },
        ExpressionAttributeValues: {
          ':rank': current.rank,
          ':expectedRevision': current.itemRevision,
          ':nextRevision': current.itemRevision + 1,
          ':updatedAt': now,
          ...(ingredientIdentity === undefined
            ? {}
            : {
                ':requestedItemId': ingredientIdentity.requestedItemId,
                ':sourceActivityId': ingredientIdentity.sourceActivityId,
                ':ingredientId': ingredientIdentity.ingredientId,
                ':outcome': ingredientIdentity.outcome,
              }),
        },
      },
    },
  );
}

/**
 * Permanently occupies a supplied destination identity that deduplicated into another row.
 *
 * Created rows need no alias because their ordinary `ITEMID#` locator is the durable
 * identity. An absorbed outcome does: without this row, receipt expiry followed by a check,
 * rename or delete of the target lets the old request create its formerly unused id.
 */
export function appendIngredientDestinationBinding(
  builder: TransactionBuilder,
  binding: IngredientDestinationBinding,
  now: string,
  current?: ListItem,
): void {
  if (binding.requestedItemId === binding.itemId) {
    if (current === undefined || current.itemId !== binding.itemId) {
      throw new Error('Binding an existing locator requires its current item snapshot.');
    }
    builder.add({
      Update: {
        Key: listItemLocator(binding.listId, binding.requestedItemId),
        UpdateExpression:
          'SET #requestedItemId = :requestedItemId, #sourceActivityId = :sourceActivityId, #ingredientId = :ingredientId, #outcome = :outcome, #updatedAt = :updatedAt',
        ConditionExpression:
          '#rank = :rank AND #itemRevision = :itemRevision AND attribute_not_exists(#ingredientId)',
        ExpressionAttributeNames: {
          '#rank': 'rank',
          '#itemRevision': 'itemRevision',
          '#requestedItemId': 'requestedItemId',
          '#sourceActivityId': 'sourceActivityId',
          '#ingredientId': 'ingredientId',
          '#outcome': 'outcome',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':rank': current.rank,
          ':itemRevision': current.itemRevision,
          ':requestedItemId': binding.requestedItemId,
          ':sourceActivityId': binding.sourceActivityId,
          ':ingredientId': binding.ingredientId,
          ':outcome': binding.outcome,
          ':updatedAt': now,
        },
      },
    });
    return;
  }
  builder.add({
    Put: {
      Item: stamp(ENTITY.ingredientDestinationBinding, now, now, {
        ...listItemLocator(binding.listId, binding.requestedItemId),
        ...binding,
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  });
}

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
    const done = created.filter((item) => item.state === 'done').length;
    builder.add({
      Update: {
        Key: listMeta(listId),
        UpdateExpression:
          'SET #rankVersion = :nextVersion, #itemCount = #itemCount + :count, #doneCount = #doneCount + :done, #lastItemActivityAt = :lastItemActivityAt ADD #itemVersion :itemVersionIncrement',
        /**
         * **The item cap is enforced here, in the transaction**, not only by the service's
         * precheck. Two creates against a 499-item list both pass that precheck, and the
         * loser retries against a refreshed `rankVersion` that carries no capacity
         * information — so without this condition the retry commits item 501.
         */
        ConditionExpression: `#rankVersion = :expectedVersion AND #itemCount <= :maxBefore AND ${GATES_ABSENT}`,
        ExpressionAttributeNames: {
          '#rankVersion': 'rankVersion',
          '#itemVersion': 'itemVersion',
          '#itemCount': 'itemCount',
          '#doneCount': 'doneCount',
          '#lastItemActivityAt': 'lastItemActivityAt',
          ...GATE_NAMES,
        },
        ExpressionAttributeValues: {
          ':lastItemActivityAt': options.now,
          ':expectedVersion': state.list.rankVersion,
          ':nextVersion': state.list.rankVersion + 1,
          ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
          ':count': created.length,
          ':done': done,
          ':maxBefore': MAX_LIST_ITEMS - created.length,
        },
      },
    });
    const receiptIndex = builder.length;
    if (options.receiptFor !== undefined) {
      builder.addReserved(receiptItem(options.receiptFor(created)));
    }

    try {
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
    } catch (error) {
      /**
       * The META item now carries two conditions that can each fail, and DynamoDB reports
       * the item rather than the clause. A strong reread separates them: a full list is
       * permanent and must surface as such, while a moved version is the ordinary conflict
       * this function retries.
       */
      if (error instanceof RetryableListMutationConflictError) {
        const current = await getLiveListMetaStrong(listId);
        if (
          current !== undefined &&
          current.itemCount + created.length > MAX_LIST_ITEMS
        ) {
          throw new ListFullError();
        }
      }
      throw error;
    }
    return created;
  });
}

export interface ReorderListItemOptions {
  readonly now: string;
  /** `null` means the front; `undefined` means the end. */
  readonly afterItemId?: string | null;
  /**
   * Field changes to apply **to the moved row, in the same transaction**.
   *
   * `PATCH` accepts a position alongside ordinary fields (`api-contract.md` §2.7), and the
   * two must not be two writes: a client that dragged a row and renamed it in one request
   * would otherwise see the rename stand while the move failed. Because the reorder already
   * re-puts the whole row at its new key, folding the patch into that put costs no extra
   * action — the transaction is still delete, put, locator, version.
   */
  readonly patch?: ListItemFieldPatch;
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
    const patched =
      options.patch === undefined
        ? current.item
        : applyItemPatch(current.item, options.patch);
    // Nothing to do only when the row neither moves nor changes; a same-rank request that
    // also carries fields still has to write them.
    if (rank === current.item.rank && options.patch === undefined) return current.item;

    const nextRevision = current.item.itemRevision + 1;
    const next: ListItem = { ...patched, rank, itemRevision: nextRevision };
    const nextRow: StoredItem = {
      ...withPatchApplied(current.row, options.patch),
      ...listItemKey(listId, rank, itemId),
      rank,
      itemRevision: nextRevision,
      updatedAt: options.now,
    };
    const doneDelta =
      Number(next.state === 'done') - Number(current.item.state === 'done');
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
          // The counter moves only when a folded-in patch changed intrinsic state; a plain drag
          // touches the version and nothing else, so the action count is unchanged either
          // way (acceptance criterion 16).
          UpdateExpression:
            doneDelta === 0
              ? 'SET #rankVersion = :nextVersion, #lastItemActivityAt = :lastItemActivityAt ADD #itemVersion :itemVersionIncrement'
              : 'SET #rankVersion = :nextVersion, #lastItemActivityAt = :lastItemActivityAt ADD #doneCount :doneDelta, #itemVersion :itemVersionIncrement',
          ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
          ExpressionAttributeNames: {
            '#rankVersion': 'rankVersion',
            '#itemVersion': 'itemVersion',
            '#lastItemActivityAt': 'lastItemActivityAt',
            ...(doneDelta === 0 ? {} : { '#doneCount': 'doneCount' }),
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':lastItemActivityAt': options.now,
            ':expectedVersion': state.list.rankVersion,
            ':nextVersion': state.list.rankVersion + 1,
            ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
            ...(doneDelta === 0 ? {} : { ':doneDelta': doneDelta }),
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
  readonly state?: ListItem['state'];
  readonly note?: string | null;
  readonly features?: PatchListItemInput['features'] | null;
}

function mergeListItemFeatures(
  current: ListItemFeatures | undefined,
  patch: NonNullable<PatchListItemInput['features']>,
): ListItemFeatures | undefined {
  const progress = (value: NonNullable<typeof patch.progress>): ProgressValue =>
    value.kind === 'text'
      ? { kind: 'text', value: value.value }
      : {
          kind: 'episode',
          ...(value.mediaKind === undefined ? {} : { mediaKind: value.mediaKind }),
          ...(value.season === undefined ? {} : { season: value.season }),
          ...(value.episode === undefined ? {} : { episode: value.episode }),
        };
  const place = (value: NonNullable<typeof patch.place>): ListPlace => ({
    label: value.label,
    ...(value.address === undefined ? {} : { address: value.address }),
    ...(value.lat === undefined ? {} : { lat: value.lat }),
    ...(value.lng === undefined ? {} : { lng: value.lng }),
  });
  const subItem = (
    value: NonNullable<NonNullable<typeof patch.subItems>['entries'][number]>,
  ): ListSubItem => ({
    id: value.id,
    title: value.title,
    rank: value.rank,
    ...(value.secondary === undefined ? {} : { secondary: value.secondary }),
  });

  const next: ListItemFeatures = { ...current };
  if ('progress' in patch) {
    if (patch.progress === null || patch.progress === undefined) delete next.progress;
    else next.progress = progress(patch.progress);
  }
  if ('place' in patch) {
    if (patch.place === null || patch.place === undefined) delete next.place;
    else next.place = place(patch.place);
  }
  if ('subItems' in patch) {
    if (patch.subItems === null || patch.subItems === undefined) delete next.subItems;
    else next.subItems = { entries: patch.subItems.entries.map(subItem) };
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/** Applies the one canonical item-field merge to either an ordinary PATCH or a moved row. */
function applyItemFields(
  row: StoredItem,
  currentFeatures: ListItemFeatures | undefined,
  patch: ListItemFieldPatch,
): StoredItem {
  const next: StoredItem = { ...row };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.state !== undefined) next.state = patch.state;
  if ('note' in patch) {
    if (patch.note === null || patch.note === undefined) delete next.note;
    else next.note = patch.note;
  }
  if ('features' in patch) {
    if (patch.features === null || patch.features === undefined) delete next.features;
    else {
      const features = mergeListItemFeatures(currentFeatures, patch.features);
      if (features === undefined) delete next.features;
      else next.features = features;
    }
  }
  return next;
}

/** Applies fields to the raw row a reorder moves, so position and fields remain one write. */
function withPatchApplied(
  row: StoredItem,
  patch: ListItemFieldPatch | undefined,
): StoredItem {
  return patch === undefined
    ? row
    : applyItemFields(row, parseListItem(row).features, patch);
}

function applyItemPatch(item: ListItem, patch: ListItemFieldPatch): ListItem {
  const next = applyItemFields({ ...item }, item.features, patch);
  next.itemRevision = item.itemRevision + 1;
  return parseListItem(next);
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

    for (const field of ['title', 'state', 'note', 'features'] as const) {
      if (!(field in patch)) continue;
      names[`#${field}`] = field;
      const value = field === 'features' ? next.features : patch[field];
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

    const doneDelta =
      Number(next.state === 'done') - Number(current.item.state === 'done');
    if (doneDelta === 0) {
      builder.add({
        Update: {
          Key: listMeta(listId),
          UpdateExpression:
            'SET #lastItemActivityAt = :lastItemActivityAt ADD #itemVersion :itemVersionIncrement',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#itemVersion': 'itemVersion',
            '#lastItemActivityAt': 'lastItemActivityAt',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
            ':lastItemActivityAt': now,
          },
        },
      });
    } else {
      builder.add({
        Update: {
          Key: listMeta(listId),
          UpdateExpression:
            'SET #lastItemActivityAt = :lastItemActivityAt ADD #doneCount :delta, #itemVersion :itemVersionIncrement',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#doneCount': 'doneCount',
            '#itemVersion': 'itemVersion',
            '#lastItemActivityAt': 'lastItemActivityAt',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':delta': doneDelta,
            ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
            ':lastItemActivityAt': now,
          },
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

/**
 * The resumable work record. Internal: never serialised to a client.
 *
 * `state` exists because the marker and the snapshot cannot be written together — the
 * snapshot is read *after* the marker is down, which is what makes it stable. So the record
 * is created `snapshotting` in the **same transaction** as the marker, and any later caller
 * can finish the snapshot under the gate. Without it, a crash between the two writes would
 * leave a marker naming nothing: every read and mutation gated forever, with no record to
 * resume from (§P3-03; schema migration uses the same resumable-work lesson).
 */
export interface RankRepairWork {
  readonly listId: string;
  readonly operationId: string;
  readonly state: 'snapshotting' | 'rewriting';
  readonly entries: RankRepairEntry[];
  /** Index of the next entry to rewrite. A crash resumes here. */
  readonly cursor: number;
  /** The `rankVersion` the marker was installed under. */
  readonly rankVersion: number;
}

const rankRepairSchema = z.object({
  listId: z.string().min(1),
  operationId: z.string().min(1),
  state: z.enum(['snapshotting', 'rewriting']),
  entries: z
    .array(
      z.object({
        itemId: z.string().min(1),
        fromRank: z.string().min(1),
        fromRevision: z.number().int().nonnegative(),
        toRank: z.string().min(1),
      }),
    )
    .default([]),
  cursor: z.number().int().nonnegative(),
  rankVersion: z.number().int().nonnegative(),
});

/** Items per repair transaction: three actions each, plus the cursor and the deletion gate. */
export const RANK_REPAIR_CHUNK = 25;

/**
 * Every ranked row, unpaged and unfenced — the snapshot read a worker takes under its own
 * marker, used by rank repair and other bounded internal workers.
 *
 * Deliberately not `listItems`: that one refuses to read while a marker stands, which is
 * exactly the state this runs in. Bounded by `MAX_LIST_ITEMS`, so `queryAll` is safe here
 * and is not safe for anything a user can grow without limit.
 *
 * It parses rows against the canonical stored item schema. Legacy schema conversion uses its
 * dedicated raw compatibility reader while the schema-migration marker gates public reads.
 */
async function readAllItemsUnfenced(listId: string): Promise<ListItem[]> {
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

  const pending: RankRepairWork = {
    listId,
    operationId: options.operationId,
    state: 'snapshotting',
    entries: [],
    cursor: 0,
    rankVersion: list.rankVersion,
  };

  /**
   * **The marker and its work record land together.** Writing the marker first and the
   * record afterwards leaves a window in which a crash gates the list forever against a
   * record nobody has; committing an empty `snapshotting` record alongside it means any
   * later caller can pick the work up and finish it.
   */
  await transactWrite(
    new TransactionBuilder('beginRankRepair')
      .add(
        listDeletionGate(listId),
        {
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
        },
        {
          Put: {
            Item: stamp(ENTITY.rankRepair, options.now, options.now, {
              ...listRankRepair(listId, options.operationId),
              ...pending,
              ttl: ttlFor(options.now),
            }),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      )
      .build(),
    {
      operation: 'beginRankRepair',
      onConditionFailed: (index) =>
        index === 0 ? new ListNotFoundError() : new RankRepairAlreadyStartedError(),
    },
  );

  return snapshotRankRepair(pending, options.now);
}

/**
 * Fills a `snapshotting` record's entries and moves it to `rewriting`.
 *
 * Separate from the install because it runs **under the marker**, where every item mutation
 * is gated and the snapshot therefore cannot go stale. It is idempotent: a caller that finds
 * the record still `snapshotting` — because the installer crashed, or because it lost a race
 * — recomputes the same entries from the same rows and commits them conditionally.
 */
export async function snapshotRankRepair(
  work: RankRepairWork,
  now: string,
): Promise<RankRepairWork> {
  if (work.state === 'rewriting') return work;

  const items = await readAllItemsUnfenced(work.listId);
  let previous = items.at(-1)?.rank ?? null;
  const entries: RankRepairEntry[] = items.map((item) => {
    const toRank = lexoRankBetween(previous);
    previous = toRank;
    return {
      itemId: item.itemId,
      fromRank: item.rank,
      fromRevision: item.itemRevision,
      toRank,
    };
  });

  await transactWrite(
    new TransactionBuilder('snapshotRankRepair')
      .add({
        Update: {
          Key: listRankRepair(work.listId, work.operationId),
          UpdateExpression:
            'SET #entries = :entries, #state = :rewriting, #updatedAt = :now',
          ConditionExpression: '#state = :snapshotting',
          ExpressionAttributeNames: {
            '#entries': 'entries',
            '#state': 'state',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':entries': entries,
            ':rewriting': 'rewriting',
            ':snapshotting': 'snapshotting',
            ':now': now,
          },
        },
      })
      .build(),
    {
      operation: 'snapshotRankRepair',
      // A concurrent drain snapshotted first. Its entries are the ones to use — both
      // computed the same moves from the same gated rows, but only one is stored.
      onConditionFailed: () => new RankRepairContendedError(),
    },
  );

  return { ...work, state: 'rewriting', entries };
}

/** Another caller already installed the marker; drain theirs rather than starting a second. */
export class RankRepairAlreadyStartedError extends Error {
  constructor() {
    super('A rank repair is already in progress for this list.');
    this.name = 'RankRepairAlreadyStartedError';
  }
}

/**
 * Another caller advanced this repair first.
 *
 * Two requests may drain the same operation — one provoked by a blocked write, one by a
 * fenced read — and they cooperate rather than conflict: the loser re-reads the authoritative
 * cursor and continues from there. Distinct from a fence failure so the drain can tell
 * "somebody else did that slice" from "this list is in a state I cannot read".
 */
export class RankRepairContendedError extends Error {
  constructor() {
    super('Another caller advanced this repair.');
    this.name = 'RankRepairContendedError';
  }
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
    // Item mutations are gated, so a missing row means a **concurrent drain of this same
    // operation** already moved it. The cursor read below would have caught that too; this
    // is the same race seen one step earlier, and the caller re-reads and continues.
    if (row === undefined) throw new RankRepairContendedError();
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
      index === 0 ? new ListNotFoundError() : new RankRepairContendedError(),
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
            /**
             * **No `lastItemActivityAt` here, deliberately** (P3-47). A rank repair rewrites
             * ranks the user already asked to change: the reorder that triggered it bumped
             * the field, and bumping again when the repair lands would move a *display*
             * timestamp for maintenance the user never performed and cannot see.
             */
            UpdateExpression:
              'SET #rankVersion = :nextVersion REMOVE #rankRepairId ADD #itemVersion :itemVersionIncrement',
            ConditionExpression:
              '#rankRepairId = :operationId AND #rankVersion = :expectedVersion',
            ExpressionAttributeNames: {
              '#rankVersion': 'rankVersion',
              '#rankRepairId': 'rankRepairId',
              '#itemVersion': 'itemVersion',
            },
            ExpressionAttributeValues: {
              ':operationId': work.operationId,
              ':expectedVersion': work.rankVersion,
              ':nextVersion': work.rankVersion + 1,
              ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
            },
          },
        },
        { Delete: { Key: listRankRepair(work.listId, work.operationId) } },
      )
      .build(),
    { operation: 'finishRankRepair' },
  );
}

/** The single-use record every reversible bulk operation leaves behind. */
function bulkUndoItem(
  listId: string,
  options: {
    readonly operationId: string;
    readonly kind: ListUndoKind;
    readonly tokenHash: string;
    readonly undoExpiresAt: string;
    readonly affectedItemIds: readonly string[];
    readonly now: string;
  },
): StoredItem {
  return stamp(ENTITY.undo, options.now, options.now, {
    ...listUndo(listId, options.operationId),
    listId,
    operationId: options.operationId,
    kind: options.kind,
    affectedItemIds: [...options.affectedItemIds],
    tokenHash: options.tokenHash,
    undoExpiresAt: options.undoExpiresAt,
    ttl: ttlFor(options.now),
    consumed: false,
    completedCount: 0,
  });
}

/** Marks one operation used, and fails if it already was. Single-use, enforced in storage. */
function consumeUndoAction(
  listId: string,
  operationId: string,
  now: string,
  completedCount?: number,
) {
  return {
    Update: {
      Key: listUndo(listId, operationId),
      UpdateExpression: `SET #consumed = :true, #consumedAt = :now, #updatedAt = :now${completedCount === undefined ? '' : ' ADD #completedCount :completedCount'}`,
      ConditionExpression: '#operationId = :operationId AND #consumed = :false',
      ExpressionAttributeNames: {
        '#operationId': 'operationId',
        '#consumed': 'consumed',
        '#consumedAt': 'consumedAt',
        '#updatedAt': 'updatedAt',
        ...(completedCount === undefined ? {} : { '#completedCount': 'completedCount' }),
      },
      ExpressionAttributeValues: {
        ':operationId': operationId,
        ':false': false,
        ':true': true,
        ':now': now,
        ...(completedCount === undefined ? {} : { ':completedCount': completedCount }),
      },
    },
  } as const;
}

/** Records one committed compensation chunk without spending the operation. */
function recordUndoProgressAction(
  listId: string,
  operationId: string,
  now: string,
  completedCount: number,
) {
  return {
    Update: {
      Key: listUndo(listId, operationId),
      UpdateExpression: 'SET #updatedAt = :now ADD #completedCount :completedCount',
      ConditionExpression: '#operationId = :operationId AND #consumed = :false',
      ExpressionAttributeNames: {
        '#operationId': 'operationId',
        '#consumed': 'consumed',
        '#updatedAt': 'updatedAt',
        '#completedCount': 'completedCount',
      },
      ExpressionAttributeValues: {
        ':operationId': operationId,
        ':false': false,
        ':now': now,
        ':completedCount': completedCount,
      },
    },
  } as const;
}

/**
 * Actions a transaction may hold beyond its per-item work: the deletion gate, the `META`
 * update, the operation record and the reserved receipt slot.
 */
const BULK_TRANSACTION_OVERHEAD = 4;

/**
 * Splits work into transactions by **cost**, not by a fixed count.
 *
 * A deleted item is three actions plus one per active viewer for its link and one per linked
 * Activity for its provenance, so a fixed chunk size that is right for a private list builds
 * an over-limit transaction on a shared one. Costing each item and filling to the budget is
 * the same answer for both, and it fails loudly rather than silently on an item that could
 * never fit alone.
 */
function costedChunks<T>(items: readonly T[], cost: (item: T) => number): T[][] {
  const budget = MAX_TRANSACT_ITEMS - BULK_TRANSACTION_OVERHEAD;
  const chunks: T[][] = [];
  let current: T[] = [];
  let spent = 0;
  for (const item of items) {
    const price = cost(item);
    if (price > budget) {
      throw new AppError('internal', 'An unexpected error occurred.', [
        { path: 'listItem', message: 'One list item needs more actions than fit.' },
      ]);
    }
    if (spent + price > budget && current.length > 0) {
      chunks.push(current);
      current = [];
      spent = 0;
    }
    current.push(item);
    spent += price;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
          ConditionExpression:
            current.ingredientIdentity === undefined
              ? '#rank = :rank AND #itemRevision = :expectedRevision AND attribute_not_exists(#ingredientId)'
              : '#rank = :rank AND #itemRevision = :expectedRevision AND #requestedItemId = :requestedItemId AND #sourceActivityId = :sourceActivityId AND #ingredientId = :ingredientId AND #outcome = :outcome',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
            '#ingredientId': 'ingredientId',
            ...(current.ingredientIdentity === undefined
              ? {}
              : {
                  '#requestedItemId': 'requestedItemId',
                  '#sourceActivityId': 'sourceActivityId',
                  '#outcome': 'outcome',
                }),
          },
          ExpressionAttributeValues: {
            ':rank': current.item.rank,
            ':expectedRevision': current.item.itemRevision,
            ...(current.ingredientIdentity === undefined
              ? {}
              : {
                  ':requestedItemId': current.ingredientIdentity.requestedItemId,
                  ':sourceActivityId': current.ingredientIdentity.sourceActivityId,
                  ':ingredientId': current.ingredientIdentity.ingredientId,
                  ':outcome': current.ingredientIdentity.outcome,
                }),
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
          UpdateExpression: 'SET #updatedAt = :updatedAt REMOVE #listId, #listItemId',
          ConditionExpression: '#listId = :listId AND #listItemId = :listItemId',
          ExpressionAttributeNames: {
            '#listId': 'listId',
            '#listItemId': 'listItemId',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':listId': provenance.listId,
            ':listItemId': provenance.listItemId,
            ':updatedAt': options.now,
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
            ...(current.ingredientIdentity === undefined
              ? {}
              : { ingredientIdentity: current.ingredientIdentity }),
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
          UpdateExpression:
            'SET #lastItemActivityAt = :lastItemActivityAt ADD #itemCount :minusOne, #doneCount :doneDelta, #itemVersion :itemVersionIncrement',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#itemCount': 'itemCount',
            '#doneCount': 'doneCount',
            '#itemVersion': 'itemVersion',
            '#lastItemActivityAt': 'lastItemActivityAt',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':lastItemActivityAt': options.now,
            ':minusOne': -1,
            ':doneDelta': current.item.state === 'done' ? -1 : 0,
            ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
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

/**
 * The answer a bulk operation committed to before it had finished committing it (P3-10).
 *
 * ## Why this row exists
 *
 * `clear-checked` at the item cap is twenty-odd transactions. The `UNDO#` record naming every
 * id lands in the first of them, so a run that dies half way leaves rows deleted under an
 * operation that is perfectly restorable — **provided anybody can still reach its token**.
 * Without this record they cannot: a retry under the same `Idempotency-Key` would find no
 * receipt, mint a fresh operation and a fresh token, delete whatever was left, and strand the
 * first chunks' items behind a token nobody ever received.
 *
 * So the operation id is derived from that key, and this row holds what a resume cannot
 * recompute: the token it already promised, the deadline it promised it for, the stable
 * snapshot it is working through, how far it got, and the receipt the last chunk will store.
 * A retry finds it and finishes the same operation, with the same answer.
 *
 * The token is held in the clear here while the operation runs: the row is internal, never
 * serialised, and **deleted by the transaction that finishes the operation**, bounding this
 * temporary copy to the run. The transaction installs the bounded exact-response receipt
 * that can replay the token; the retained `UNDO#` authority stores only its hash.
 */
export interface BulkItemOperationWork {
  readonly listId: string;
  readonly operationId: string;
  readonly kind: 'clear_done' | 'reopen_done';
  /** Taken once, before the first chunk. What the operation applies, and what Undo reverses. */
  readonly itemIds: readonly string[];
  /** How many of them are done. A retry resumes here. */
  readonly cursor: number;
  /** First accepted request instant; every resumed chunk reuses it. */
  readonly acceptedAt?: Instant;
  /** Legacy work rows use their creation instant to seed `acceptedAt` on first resume. */
  readonly createdAt: Instant;
  readonly undoToken: string;
  readonly undoExpiresAt: string;
  readonly receipt?: IdempotencyReceipt;
}

const bulkOperationSchema = z.object({
  listId: z.string().min(1),
  operationId: z.string().min(1),
  kind: z.enum(['clear_done', 'reopen_done']),
  itemIds: z.array(z.string().min(1)).default([]),
  cursor: z.number().int().nonnegative(),
  acceptedAt: instant.optional(),
  createdAt: instant,
  undoToken: z.string().min(1),
  undoExpiresAt: z.string().min(1),
  receipt: z
    .object({
      userId: z.string().min(1),
      key: z.string().min(1),
      route: z.string().min(1),
      status: z.number().int(),
      body: z.string().min(1),
      ttl: z.number().int(),
      createdAt: z.string().min(1),
    })
    .optional(),
});

function parseBulkItemOperationWork(value: unknown): BulkItemOperationWork {
  const parsed = bulkOperationSchema.parse(value);
  return {
    listId: parsed.listId,
    operationId: parsed.operationId,
    kind: parsed.kind,
    itemIds: parsed.itemIds,
    cursor: parsed.cursor,
    ...(parsed.acceptedAt === undefined ? {} : { acceptedAt: parsed.acceptedAt }),
    createdAt: parsed.createdAt,
    undoToken: parsed.undoToken,
    undoExpiresAt: parsed.undoExpiresAt,
    ...(parsed.receipt === undefined ? {} : { receipt: parsed.receipt }),
  };
}

/** The outstanding work for one operation, or `undefined` once it has finished. */
export async function getBulkItemOperation(
  listId: string,
  operationId: string,
): Promise<BulkItemOperationWork | undefined> {
  const row = await getItem<StoredItem>(listBulkOperation(listId, operationId), {
    consistentRead: true,
  });
  return row === undefined ? undefined : parseBulkItemOperationWork(row);
}

type AcceptedBulkItemOperationWork = BulkItemOperationWork & {
  readonly acceptedAt: Instant;
};

/** Upgrades a pre-`acceptedAt` work row without changing a timestamp already installed. */
async function acceptBulkItemOperation(
  work: BulkItemOperationWork,
): Promise<AcceptedBulkItemOperationWork> {
  const acceptedAt = work.createdAt;
  try {
    const row = await updateItem<StoredItem>(
      listBulkOperation(work.listId, work.operationId),
      {
        expression: 'SET #acceptedAt = if_not_exists(#acceptedAt, :now)',
        names: { '#acceptedAt': 'acceptedAt', '#operationId': 'operationId' },
        values: { ':now': acceptedAt, ':operationId': work.operationId },
        condition: '#operationId = :operationId',
      },
    );
    if (row === undefined) throw new BulkOperationContendedError();
    const accepted = parseBulkItemOperationWork(row);
    if (accepted.acceptedAt === undefined) {
      throw new Error('Bulk operation acceptance timestamp was not stored.');
    }
    return { ...accepted, acceptedAt: accepted.acceptedAt };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new BulkOperationContendedError();
    }
    throw error;
  }
}

/** What the service decides when an operation is **new**; a resume uses what was recorded. */
export interface BulkOperationPlan {
  readonly undoToken: string;
  readonly tokenHash: string;
  readonly undoExpiresAt: string;
  readonly receipt?: IdempotencyReceipt;
}

export interface RunBulkOperationOptions {
  readonly operationId: string;
  readonly kind: 'clear_done' | 'reopen_done';
  readonly now: string;
  readonly plan: (itemIds: readonly string[]) => BulkOperationPlan;
}

export interface BulkOperationResult {
  readonly affectedCount: number;
  readonly undoToken: string;
  readonly undoExpiresAt: string;
}

/**
 * Runs one bulk checked operation to completion, resuming one already started (§P3-10).
 *
 * Three phases because the snapshot cannot be
 * written in the same transaction that takes it, and the work has to survive between them.
 *
 * 1. The stable snapshot is taken, the caller plans the answer, and one transaction installs
 *    the work record **and** the `UNDO#` record naming every id. Nothing is applied yet, so a
 *    crash here leaves an operation that reverses nothing — which is what it did.
 * 2. Bounded chunks apply the change and advance the stored cursor in the same transaction, so
 *    a crash resumes at a chunk boundary and never half-applies one item.
 * 3. One final transaction stores the response receipt and deletes the work record, so its
 *    temporary plaintext-token copy goes with it. The bounded receipt remains for exact
 *    response replay; the retained `UNDO#` authority holds only the hash.
 *
 * Each chunk re-reads its items' current revisions rather than trusting the snapshot's. The
 * ids are what the operation recorded and will reverse; the revisions are how it writes them
 * safely, and a resume minutes later must use the current ones.
 */
export async function runBulkCheckedOperation(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  options: RunBulkOperationOptions,
): Promise<BulkOperationResult> {
  const state = await readMutationState(userId, listId, access);

  const storedWork = await getBulkItemOperation(listId, options.operationId);
  let work: AcceptedBulkItemOperationWork;
  if (storedWork === undefined) {
    const doneItems = (await readAllItemsUnfenced(listId)).filter(
      (item) => item.state === 'done',
    );
    const itemIds = doneItems.map((item) => item.itemId);
    const plan = options.plan(itemIds);
    const acceptedAt = instant.parse(options.now);
    work = {
      listId,
      operationId: options.operationId,
      kind: options.kind,
      itemIds,
      cursor: 0,
      acceptedAt,
      createdAt: acceptedAt,
      undoToken: plan.undoToken,
      undoExpiresAt: plan.undoExpiresAt,
      ...(plan.receipt === undefined ? {} : { receipt: plan.receipt }),
    };
    await transactWrite(
      new TransactionBuilder('beginBulkCheckedOperation')
        .add(
          listDeletionGate(listId),
          {
            Put: {
              Item: stamp(ENTITY.bulkOperation, options.now, options.now, {
                ...listBulkOperation(listId, options.operationId),
                ...work,
                ttl: ttlFor(options.now),
              }),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              Item: bulkUndoItem(listId, {
                operationId: options.operationId,
                kind: options.kind,
                tokenHash: plan.tokenHash,
                undoExpiresAt: plan.undoExpiresAt,
                affectedItemIds: itemIds,
                now: options.now,
              }),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        )
        .build(),
      {
        operation: 'beginBulkCheckedOperation',
        onConditionFailed: (index) =>
          index === 0 ? new ListNotFoundError() : new BulkOperationContendedError(),
      },
    );
  } else {
    work =
      storedWork.acceptedAt === undefined
        ? await acceptBulkItemOperation(storedWork)
        : { ...storedWork, acceptedAt: storedWork.acceptedAt };
  }

  while (work.cursor < work.itemIds.length) {
    work = await applyBulkChunk(state.list, work, work.acceptedAt);
  }
  await finishBulkOperation(work);

  return {
    affectedCount: work.itemIds.length,
    undoToken: work.undoToken,
    undoExpiresAt: work.undoExpiresAt,
  };
}

/** Another caller is already running this operation; its own retry will finish it. */
export class BulkOperationContendedError extends Error {
  constructor() {
    super('This bulk operation is already running.');
    this.name = 'BulkOperationContendedError';
  }
}

/** Applies the next bounded slice and advances the stored cursor in the same transaction. */
async function applyBulkChunk(
  list: List,
  work: AcceptedBulkItemOperationWork,
  now: Instant,
): Promise<AcceptedBulkItemOperationWork> {
  const { listId, operationId } = work;
  const remaining = work.itemIds.slice(work.cursor);
  const current = new Map(
    (await readAllItemsUnfenced(listId)).map((item) => [item.itemId, item] as const),
  );

  const pending = await Promise.all(
    remaining.map(async (itemId) => {
      const item = current.get(itemId);
      if (item === undefined) return { itemId, item: undefined, cost: 1 };
      if (work.kind === 'reopen_done') return { itemId, item, cost: 2 };
      const relationships = await readRelationshipSnapshot(list, itemId);
      return {
        itemId,
        item,
        relationships,
        cost:
          3 + relationships.viewerIds.length + relationships.activityProvenance.length,
      };
    }),
  );

  const [chunk = []] = costedChunks(pending, (entry) => entry.cost);
  const ingredientIdentities = new Map(
    (
      await batchGetItems<StoredItem>(
        chunk.flatMap((entry) =>
          entry.item === undefined ? [] : [listItemLocator(listId, entry.item.itemId)],
        ),
        { consistentRead: true },
      )
    ).flatMap((row) => {
      const parsed = ingredientDestinationBindingSchema.safeParse(row);
      return parsed.success ? ([[parsed.data.itemId, parsed.data]] as const) : [];
    }),
  );
  const builder = new TransactionBuilder('applyBulkChunk').add(listDeletionGate(listId));
  let applied = 0;

  for (const entry of chunk) {
    /**
     * An id the snapshot named that is no longer here — deleted by hand, or applied by a
     * previous attempt of this same operation whose response was lost. Either way the change
     * this chunk would make is already true, so the cursor moves past it.
     */
    if (entry.item === undefined) continue;
    const item = entry.item;
    const ingredientIdentity = ingredientIdentities.get(item.itemId);
    if (work.kind === 'reopen_done') {
      if (item.state !== 'done') continue;
      const nextRevision = item.itemRevision + 1;
      builder.add(
        {
          Update: {
            Key: listItemKey(listId, item.rank, item.itemId),
            UpdateExpression:
              'SET #state = :open, #itemRevision = :next, #updatedAt = :now',
            ConditionExpression: '#itemRevision = :expected AND #state = :done',
            ExpressionAttributeNames: {
              '#state': 'state',
              '#itemRevision': 'itemRevision',
              '#updatedAt': 'updatedAt',
            },
            ExpressionAttributeValues: {
              ':open': 'open',
              ':done': 'done',
              ':expected': item.itemRevision,
              ':next': nextRevision,
              ':now': now,
            },
          },
        },
        {
          Update: {
            Key: listItemLocator(listId, item.itemId),
            UpdateExpression: 'SET #itemRevision = :next',
            ConditionExpression: '#rank = :rank AND #itemRevision = :expected',
            ExpressionAttributeNames: {
              '#rank': 'rank',
              '#itemRevision': 'itemRevision',
            },
            ExpressionAttributeValues: {
              ':rank': item.rank,
              ':expected': item.itemRevision,
              ':next': nextRevision,
            },
          },
        },
      );
      applied += 1;
      continue;
    }

    const relationships = entry.relationships;
    if (relationships === undefined) continue;
    builder.add(
      {
        Delete: {
          Key: listItemKey(listId, item.rank, item.itemId),
          ConditionExpression: '#itemRevision = :expectedRevision',
          ExpressionAttributeNames: { '#itemRevision': 'itemRevision' },
          ExpressionAttributeValues: { ':expectedRevision': item.itemRevision },
        },
      },
      {
        Delete: {
          Key: listItemLocator(listId, item.itemId),
          ConditionExpression:
            ingredientIdentity === undefined
              ? '#rank = :rank AND #itemRevision = :expectedRevision AND attribute_not_exists(#ingredientId)'
              : '#rank = :rank AND #itemRevision = :expectedRevision AND #requestedItemId = :requestedItemId AND #sourceActivityId = :sourceActivityId AND #ingredientId = :ingredientId AND #outcome = :outcome',
          ExpressionAttributeNames: {
            '#rank': 'rank',
            '#itemRevision': 'itemRevision',
            '#ingredientId': 'ingredientId',
            ...(ingredientIdentity === undefined
              ? {}
              : {
                  '#requestedItemId': 'requestedItemId',
                  '#sourceActivityId': 'sourceActivityId',
                  '#outcome': 'outcome',
                }),
          },
          ExpressionAttributeValues: {
            ':rank': item.rank,
            ':expectedRevision': item.itemRevision,
            ...(ingredientIdentity === undefined
              ? {}
              : {
                  ':requestedItemId': ingredientIdentity.requestedItemId,
                  ':sourceActivityId': ingredientIdentity.sourceActivityId,
                  ':ingredientId': ingredientIdentity.ingredientId,
                  ':outcome': ingredientIdentity.outcome,
                }),
          },
        },
      },
    );
    const linkedViewerIds = new Set(
      relationships.viewerLinks.map((link) => link.viewerUserId),
    );
    for (const link of relationships.viewerLinks) {
      builder.add({
        Delete: {
          Key: listItemActivityLink(listId, link.viewerUserId, item.itemId),
          ConditionExpression: '#activityId = :activityId',
          ExpressionAttributeNames: { '#activityId': 'activityId' },
          ExpressionAttributeValues: { ':activityId': link.activityId },
        },
      });
    }
    for (const viewerUserId of relationships.viewerIds) {
      if (linkedViewerIds.has(viewerUserId)) continue;
      builder.add({
        ConditionCheck: {
          Key: listItemActivityLink(listId, viewerUserId, item.itemId),
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      });
    }
    for (const provenance of relationships.activityProvenance) {
      builder.add({
        Update: {
          Key: activityMeta(provenance.activityId),
          UpdateExpression: 'SET #updatedAt = :updatedAt REMOVE #listId, #listItemId',
          ConditionExpression: '#listId = :listId AND #listItemId = :listItemId',
          ExpressionAttributeNames: {
            '#listId': 'listId',
            '#listItemId': 'listItemId',
            '#updatedAt': 'updatedAt',
          },
          ExpressionAttributeValues: {
            ':listId': provenance.listId,
            ':listItemId': provenance.listItemId,
            ':updatedAt': now,
          },
        },
      });
    }
    builder.add({
      Put: {
        Item: stamp(ENTITY.itemTombstone, now, now, {
          ...listItemTombstone(listId, item.itemId),
          listId,
          itemId: item.itemId,
          operationId,
          deletedAt: now,
          ttl: ttlFor(now),
          snapshot: item,
          ...(ingredientIdentity === undefined ? {} : { ingredientIdentity }),
          viewerLinks: relationships.viewerLinks,
          activityProvenance: relationships.activityProvenance,
        }),
        ConditionExpression: 'attribute_not_exists(pk)',
      },
    });
    applied += 1;
  }

  if (applied > 0) {
    builder.add({
      Update: {
        Key: listMeta(listId),
        /**
         * **One value for the whole operation, not one per chunk** (§P3-47: a bulk operation
         * bumps this once, not once per item). `now` arrives from `runBulkCheckedOperation`'s
         * stored `acceptedAt`, read once at the edge and persisted before any chunk, so every
         * chunk and every resumed request writes the identical instant and the field moves
         * exactly once however many transactions the operation needs.
         */
        UpdateExpression:
          work.kind === 'reopen_done'
            ? 'SET #lastItemActivityAt = :lastItemActivityAt ADD #doneCount :delta, #itemVersion :itemVersionIncrement'
            : 'SET #lastItemActivityAt = :lastItemActivityAt ADD #itemCount :delta, #doneCount :delta, #itemVersion :itemVersionIncrement',
        ConditionExpression: GATES_ABSENT,
        ExpressionAttributeNames: {
          ...(work.kind === 'reopen_done'
            ? { '#doneCount': 'doneCount' }
            : { '#itemCount': 'itemCount', '#doneCount': 'doneCount' }),
          '#itemVersion': 'itemVersion',
          '#lastItemActivityAt': 'lastItemActivityAt',
          ...GATE_NAMES,
        },
        ExpressionAttributeValues: {
          ':delta': -applied,
          ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
          ':lastItemActivityAt': now,
        },
      },
    });
  }

  const nextCursor = work.cursor + chunk.length;
  builder.add({
    Update: {
      Key: listBulkOperation(listId, operationId),
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
    operation: 'applyBulkChunk',
    onConditionFailed: (index) =>
      index === 0 ? new ListNotFoundError() : new RetryableListMutationConflictError(),
  });
  return { ...work, cursor: nextCursor };
}

/**
 * Stores the response receipt and removes the work record, atomically.
 *
 * The receipt lands **here**, with the last chunk, so a replay that arrives before the
 * operation is done finds none and resumes it rather than being told it succeeded. Deleting
 * the work record in the same transaction bounds that row's plaintext-token copy to the run;
 * the capability-bearing receipt then owns the bounded copy needed for exact replay.
 */
async function finishBulkOperation(work: BulkItemOperationWork): Promise<void> {
  const builder = new TransactionBuilder(
    'finishBulkOperation',
    work.receipt === undefined ? 0 : 1,
  ).add({ Delete: { Key: listBulkOperation(work.listId, work.operationId) } });
  if (work.receipt !== undefined) builder.addReserved(receiptItem(work.receipt));

  await transactWrite(builder.build(), {
    operation: 'finishBulkOperation',
    onConditionFailed: () => new IdempotencyRaceError(),
  });
}

export interface CompensateOptions {
  readonly operationId: string;
  readonly now: string;
  /**
   * Built from the count the compensation really applied, and joined to the transaction that
   * finishes it.
   *
   * A callback rather than a prebuilt receipt, for `createListItems`'s reason: `affectedCount`
   * is decided in here — how many tombstones still stand, how many affected items survive —
   * and a receipt built before that would replay a number that was never true for the next 24
   * hours. A stored response has to be the response.
   */
  readonly receiptFor?: (affectedCount: number) => IdempotencyReceipt;
}

interface ResumableCompensateOptions extends CompensateOptions {
  /** Count already committed by an earlier process before this resume. */
  readonly previouslyAffectedCount?: number;
}

/**
 * Re-checks the members of an `uncheck-all` set that still exist (§P3-10).
 *
 * Only that set: an item somebody checked by hand during the window is not in it, and an item
 * independently deleted is simply gone. Compensation restores what the operation changed and
 * nothing else, which is what makes it safe on a shared list.
 */
export async function restoreDoneStates(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemIds: readonly string[],
  options: ResumableCompensateOptions,
): Promise<number> {
  await readMutationState(userId, listId, access);
  const wanted = new Set(itemIds);
  const surviving = (await readAllItemsUnfenced(listId)).filter(
    (item) => wanted.has(item.itemId) && item.state !== 'done',
  );
  const chunks = costedChunks(surviving, () => 2);
  const lastIndex = chunks.length - 1;
  const affectedCount = (options.previouslyAffectedCount ?? 0) + surviving.length;

  /**
   * The retry wraps **one chunk**, never the whole compensation.
   *
   * Retrying the whole thing re-read current storage from the top, so a chunk that had already
   * committed disappeared from the count — and worse, an item that chunk re-checked and the
   * user then unchecked would re-enter the query and be overwritten by the same old inverse.
   * A compensation must not undo a choice the user made after it.
   */
  for (const [index, chunk] of chunks.entries()) {
    await retryMutation(async () => {
      const isLast = index === lastIndex;
      const builder = new TransactionBuilder(
        'restoreDoneStates',
        isLast && options.receiptFor !== undefined ? 1 : 0,
      ).add(listDeletionGate(listId));

      for (const item of chunk) {
        const nextRevision = item.itemRevision + 1;
        builder.add(
          {
            Update: {
              Key: listItemKey(listId, item.rank, item.itemId),
              UpdateExpression:
                'SET #state = :done, #itemRevision = :next, #updatedAt = :now',
              /**
               * The revision this chunk read. An item somebody has touched since fails the
               * condition and the chunk retries against the newer row — it never re-checks a
               * row on the strength of a revision the compensation saw before.
               */
              ConditionExpression: '#itemRevision = :expected',
              ExpressionAttributeNames: {
                '#state': 'state',
                '#itemRevision': 'itemRevision',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':done': 'done',
                ':expected': item.itemRevision,
                ':next': nextRevision,
                ':now': options.now,
              },
            },
          },
          {
            Update: {
              Key: listItemLocator(listId, item.itemId),
              UpdateExpression: 'SET #itemRevision = :next',
              ConditionExpression: '#rank = :rank AND #itemRevision = :expected',
              ExpressionAttributeNames: {
                '#rank': 'rank',
                '#itemRevision': 'itemRevision',
              },
              ExpressionAttributeValues: {
                ':rank': item.rank,
                ':expected': item.itemRevision,
                ':next': nextRevision,
              },
            },
          },
        );
      }
      builder.add({
        Update: {
          Key: listMeta(listId),
          UpdateExpression:
            'SET #lastItemActivityAt = :lastItemActivityAt ADD #doneCount :taken, #itemVersion :itemVersionIncrement',
          ConditionExpression: GATES_ABSENT,
          ExpressionAttributeNames: {
            '#doneCount': 'doneCount',
            '#itemVersion': 'itemVersion',
            '#lastItemActivityAt': 'lastItemActivityAt',
            ...GATE_NAMES,
          },
          ExpressionAttributeValues: {
            ':lastItemActivityAt': options.now,
            ':taken': chunk.length,
            ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
          },
        },
      });
      // The operation is spent by the transaction that finishes it, never before.
      builder.add(
        isLast
          ? consumeUndoAction(listId, options.operationId, options.now, chunk.length)
          : recordUndoProgressAction(
              listId,
              options.operationId,
              options.now,
              chunk.length,
            ),
      );
      if (isLast && options.receiptFor !== undefined) {
        builder.addReserved(receiptItem(options.receiptFor(affectedCount)));
      }

      await transactWrite(builder.build(), {
        operation: 'restoreDoneStates',
        onConditionFailed: (entry) => {
          if (entry === 0) return new ListNotFoundError();
          return new RetryableListMutationConflictError();
        },
      });
    });
  }

  if (chunks.length === 0) await consumeOnly(listId, options, affectedCount);
  /**
   * The count is the set this attempt found to compensate, decided before any of it ran, so a
   * chunk-level retry cannot shrink it half way through.
   */
  return affectedCount;
}

/** Spends an operation whose inverse touched nothing that still exists. */
async function consumeOnly(
  listId: string,
  options: CompensateOptions,
  affectedCount = 0,
): Promise<void> {
  const builder = new TransactionBuilder(
    'consumeListUndo',
    options.receiptFor === undefined ? 0 : 1,
  ).add(
    listDeletionGate(listId),
    consumeUndoAction(listId, options.operationId, options.now),
  );
  if (options.receiptFor !== undefined) {
    builder.addReserved(receiptItem(options.receiptFor(affectedCount)));
  }
  await transactWrite(builder.build(), {
    operation: 'consumeListUndo',
    onConditionFailed: (index) =>
      index === 0 ? new ListNotFoundError() : new ListUndoNotApplicableError(),
  });
}

export interface RestoreListItemOptions extends CompensateOptions {}

/**
 * Puts back every item one delete operation took, byte for byte (§P3-10).
 *
 * ## Why this is not an ordinary create
 *
 * A create is refused by `ITEM_TOMBSTONE#`, and must be: weakening that check is what would
 * let a delayed offline create resurrect data the user deleted weeks ago. This is the sole
 * path past it, and it earns that by naming the operation — every tombstone it removes has to
 * carry the same `operationId`, so a token for one delete cannot reclaim another's ids.
 *
 * Items come back at their **previous ranks**, not appended: "a restored shopping list in a
 * different order is a failed undo". `rankVersion` still advances, because the ranked rows
 * changed and any cursor issued across the delete must not be resumed through them.
 *
 * Links and provenance are restored only where they are still true —
 * {@link readRestorableRelationships} drops a link whose Activity was deleted or repointed
 * meanwhile, so an item comes back with a live state line or with none, never a dead one.
 *
 * The operation is spent by the transaction that **finishes** the restore, so a seven-item
 * clear that needs three chunks is still one single-use compensation. A tombstone that is
 * missing is skipped rather than fatal: it is an item this operation never deleted, or one a
 * previous chunk already put back. Being asked to restore something and finding **nothing**
 * left to restore is the different case, and is not applicable.
 */
export async function restoreListItems(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemIds: readonly string[],
  options: RestoreListItemOptions & ResumableCompensateOptions,
): Promise<ListItem[]> {
  const state = await readMutationState(userId, listId, access);
  if (itemIds.length === 0) {
    await consumeOnly(listId, options, options.previouslyAffectedCount ?? 0);
    return [];
  }
  {
    const tombstoneRows = await batchGetItems<StoredItem>(
      itemIds.map((itemId) => listItemTombstone(listId, itemId)),
      { consistentRead: true },
    );
    const tombstones = tombstoneRows
      .map((row) => itemTombstoneSchema.parse(row))
      .filter(
        (tombstone) =>
          tombstone.listId === listId && tombstone.operationId === options.operationId,
      );
    if (tombstones.length === 0) {
      const previouslyAffectedCount = options.previouslyAffectedCount ?? 0;
      if (previouslyAffectedCount === 0) throw new ListUndoNotApplicableError();
      await consumeOnly(listId, options, previouslyAffectedCount);
      return [];
    }

    const affectedCount = (options.previouslyAffectedCount ?? 0) + tombstones.length;

    const entries = await Promise.all(
      tombstones.map(async (tombstone) => ({
        item: parseListItem(tombstone.snapshot),
        tombstone,
        relationships: await readRestorableRelationships(state.list, tombstone),
      })),
    );
    const chunks = costedChunks(
      entries,
      (entry) =>
        3 +
        entry.relationships.linksToPut.length +
        entry.relationships.activityProvenanceToPut.length,
    );

    let version = state.list.rankVersion;
    const restored: ListItem[] = [];
    /**
     * The retry wraps **one chunk**. Retrying the whole restore re-read the tombstones from
     * the top, and the ones an earlier chunk had already removed were gone — so the count it
     * reported, and the items it returned, shrank to whatever the last attempt happened to
     * find rather than what the operation actually put back.
     */
    for (const [index, chunk] of chunks.entries()) {
      await retryMutation(async () => {
        const isLast = index === chunks.length - 1;
        const builder = new TransactionBuilder(
          'restoreListItems',
          isLast && options.receiptFor !== undefined ? 1 : 0,
        ).add(listDeletionGate(listId));
        const relationshipIndexes: number[] = [];

        for (const { item, tombstone, relationships } of chunk) {
          builder.add(
            {
              Put: {
                Item: storedListItem(item, options.now),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                Item: storedLocator(item, options.now, tombstone.ingredientIdentity),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          );
          for (const link of relationships.linksToPut) {
            relationshipIndexes.push(builder.length);
            builder.add({
              Put: {
                Item: storedListItemActivityLink(link, options.now),
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            });
          }
          for (const provenance of relationships.activityProvenanceToPut) {
            relationshipIndexes.push(builder.length);
            builder.add({
              Update: {
                Key: activityMeta(provenance.activityId),
                UpdateExpression:
                  'SET #listId = :listId, #listItemId = :listItemId, #updatedAt = :updatedAt',
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(#listId) AND attribute_not_exists(#listItemId)',
                ExpressionAttributeNames: {
                  '#listId': 'listId',
                  '#listItemId': 'listItemId',
                  '#updatedAt': 'updatedAt',
                },
                ExpressionAttributeValues: {
                  ':listId': provenance.listId,
                  ':listItemId': provenance.listItemId,
                  ':updatedAt': options.now,
                },
              },
            });
          }
          builder.add({
            Delete: {
              Key: listItemTombstone(listId, item.itemId),
              ConditionExpression: '#operationId = :operationId',
              ExpressionAttributeNames: { '#operationId': 'operationId' },
              ExpressionAttributeValues: { ':operationId': options.operationId },
            },
          });
        }

        builder.add(
          isLast
            ? consumeUndoAction(listId, options.operationId, options.now, chunk.length)
            : recordUndoProgressAction(
                listId,
                options.operationId,
                options.now,
                chunk.length,
              ),
        );
        const nextVersion = version + 1;
        builder.add({
          Update: {
            Key: listMeta(listId),
            UpdateExpression:
              'SET #rankVersion = :nextVersion, #lastItemActivityAt = :lastItemActivityAt ADD #itemCount :count, #doneCount :done, #itemVersion :itemVersionIncrement',
            ConditionExpression: `#rankVersion = :expectedVersion AND ${GATES_ABSENT}`,
            ExpressionAttributeNames: {
              '#rankVersion': 'rankVersion',
              '#itemVersion': 'itemVersion',
              '#itemCount': 'itemCount',
              '#doneCount': 'doneCount',
              '#lastItemActivityAt': 'lastItemActivityAt',
              ...GATE_NAMES,
            },
            ExpressionAttributeValues: {
              ':lastItemActivityAt': options.now,
              ':expectedVersion': version,
              ':nextVersion': nextVersion,
              ':itemVersionIncrement': ITEM_VERSION_INCREMENT,
              ':count': chunk.length,
              ':done': chunk.filter((entry) => entry.item.state === 'done').length,
            },
          },
        });
        const metaIndex = builder.length - 1;
        const receiptIndex = builder.length;
        if (isLast && options.receiptFor !== undefined) {
          builder.addReserved(receiptItem(options.receiptFor(affectedCount)));
        }

        await transactWrite(builder.build(), {
          operation: 'restoreListItems',
          onConditionFailed: (entry) => {
            if (entry === 0) return new ListNotFoundError();
            if (entry === metaIndex || relationshipIndexes.includes(entry)) {
              return new RetryableListMutationConflictError();
            }
            if (isLast && options.receiptFor !== undefined && entry === receiptIndex) {
              return new IdempotencyRaceError();
            }
            return new ListUndoNotApplicableError();
          },
        });
        version = nextVersion;
      });
      restored.push(...chunk.map((entry) => entry.item));
    }

    return restored;
  }
}

/** The narrow single-item form P3-08's delete undo uses; one id is one chunk. */
export async function restoreListItem(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  itemId: string,
  options: RestoreListItemOptions,
): Promise<ListItem> {
  const [restored] = await restoreListItems(userId, listId, access, [itemId], {
    ...options,
    previouslyAffectedCount: 0,
  });
  if (restored === undefined) throw new ListUndoNotApplicableError();
  return restored;
}

/**
 * Applies one settings or archive inverse, or refuses it, in a single transaction (§P3-10).
 *
 * ## Why the preconditions are conditions, not a read
 *
 * "Applies only while its recorded preconditions remain true" cannot be a check followed by a
 * write — the gap between them is exactly the window a second device edits in. Every recorded
 * precondition becomes a condition on the same `META` update that applies the inverse, so the
 * whole compensation either lands on the state it was recorded against or lands not at all.
 *
 * Each supplied settings field has its own precondition. That lets one switch be undone while
 * an unrelated setting changed later: a whole-row inverse would put the other edit back where
 * it was, and a whole-row condition would refuse an Undo that is still applicable.
 *
 * A slot inverse also restores the exact profile default the forward change removed, and only
 * while that slot is still empty — a newer destination chosen since makes the **whole**
 * inverse no longer applicable, which is what one transaction gives for free.
 */
export async function applyListSettingsInverse(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  inverse: ListSettingsInverse,
  preconditions: ListSettingsPreconditions,
  options: CompensateOptions,
): Promise<void> {
  assertListAccessGrant(userId, listId, access);

  // `GATES_ABSENT` names both work markers, so its aliases have to be declared with the rest.
  const names: Record<string, string> = { '#updatedAt': 'updatedAt', ...GATE_NAMES };
  const values: Record<string, unknown> = { ':now': options.now };
  const sets = ['#updatedAt = :now'];
  const conditions: string[] = [];

  for (const field of ['title', 'itemStateMode', 'featureConfig'] as const) {
    if (inverse[field] !== undefined) {
      names[`#${field}`] = field;
      values[`:prior_${field}`] = inverse[field];
      sets.push(`#${field} = :prior_${field}`);
    }
    if (preconditions[field] !== undefined) {
      names[`#${field}`] = field;
      values[`:expected_${field}`] = preconditions[field];
      conditions.push(`#${field} = :expected_${field}`);
    }
  }
  if ('slot' in inverse) {
    names['#slot'] = 'slot';
    values[':priorSlot'] = inverse.slot ?? null;
    sets.push('#slot = :priorSlot');
  }
  if ('slot' in preconditions) {
    names['#slot'] = 'slot';
    values[':expectedSlot'] = preconditions.slot ?? null;
    conditions.push('#slot = :expectedSlot');
  }
  if (inverse.archived !== undefined) {
    names['#archived'] = 'archived';
    values[':priorArchived'] = inverse.archived;
    sets.push('#archived = :priorArchived');
  }
  if (preconditions.archived !== undefined) {
    names['#archived'] = 'archived';
    values[':expectedArchived'] = preconditions.archived;
    conditions.push('#archived = :expectedArchived');
  }

  const builder = new TransactionBuilder(
    'applyListSettingsInverse',
    options.receiptFor === undefined ? 0 : 1,
  ).add(listDeletionGate(listId), {
    Update: {
      Key: listMeta(listId),
      UpdateExpression: `SET ${sets.join(', ')}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: [...conditions, GATES_ABSENT].join(' AND '),
    },
  });
  const metaIndex = builder.length - 1;

  let profileIndex = -1;
  if (inverse.removedDefault !== undefined) {
    profileIndex = builder.length;
    builder.add(
      restoreDefaultListTransactItem(
        userId,
        inverse.removedDefault.slot,
        inverse.removedDefault.listId,
      ),
    );
  }
  builder.add(consumeUndoAction(listId, options.operationId, options.now));
  const consumeIndex = builder.length - 1;
  if (options.receiptFor !== undefined) {
    // One list, changed back. The count a settings compensation reports is always one.
    builder.addReserved(receiptItem(options.receiptFor(1)));
  }

  await transactWrite(builder.build(), {
    operation: 'applyListSettingsInverse',
    onConditionFailed: (index) => {
      if (index === 0) return new ListNotFoundError();
      if (index === metaIndex || index === profileIndex || index === consumeIndex) {
        return new ListUndoNotApplicableError();
      }
      return new IdempotencyRaceError();
    },
  });
}

/**
 * Spends one retained operation without restoring anything.
 *
 * The settings and archive inverses apply their own conditional `META` write and then need
 * the operation marked used in the same transaction; this is the form for a compensation that
 * legitimately touches no items at all — an empty `clear-checked`, or an `uncheck-all` whose
 * every affected item has since been deleted.
 */
export async function consumeListUndoOperation(
  userId: string,
  listId: string,
  access: ListAccessGrant,
  options: CompensateOptions,
): Promise<void> {
  assertListAccessGrant(userId, listId, access);
  await consumeOnly(listId, options);
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
    await clearListProvenance(activityId, listId, options.now);
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

/**
 * Clears one List's `sourceActivityId` back-link when its source Plan is deleted (P3-50).
 *
 * The mirror of the projection delete in {@link beginDeleteList}: that direction is a List
 * going away and taking its `SOURCE_LIST#` row with it, this one is the **Plan** going away
 * and taking the row that pointed at the List. Both halves have to exist, or one side of a
 * two-way link outlives the other — and until this shipped it was the Plan side that did,
 * leaving a List whose header named an activity that no longer existed.
 *
 * ## Conditional, and a failure is success
 *
 * `sourceActivityId = :sourceActivityId` is the whole idempotency story. A List already
 * cleared by an earlier attempt, deleted since, or re-sourced to a different Plan all fail the
 * condition, and all three are correct outcomes for a cascade that may run twice. Swallowing
 * it is what lets the caller retry a partially finished delete without a cursor.
 *
 * ## It does not advance `updatedAt`, and that is not an oversight
 *
 * Rank repair and aggregate conversion pin the List snapshot while their marker is present.
 * Moving the version underneath in-flight work would make its final condition fail
 * permanently, so freshening a concurrency token is not worth stranding the list.
 *
 * It is safe to leave alone because {@link patchListMeta} is `SET` over named fields and never
 * a whole-item `Put`, so no client holding a pre-clear copy can write the attribute back. The
 * worst case is one stale render of a link that has gone, corrected by the next read.
 *
 * For the same reason the write is **not** gated on the migration or repair markers: removing
 * an unrelated META attribute leaves `updatedAt`, `rankVersion` and migration markers
 * untouched, so every in-flight condition still holds — while gating it would let a running
 * migration block a Plan deletion and leave behind the dangling link this exists to remove.
 */
export async function clearSourceActivity(
  listId: string,
  sourceActivityId: string,
): Promise<void> {
  try {
    await updateItem(listMeta(listId), {
      expression: 'REMOVE #sourceActivityId',
      names: { '#sourceActivityId': 'sourceActivityId' },
      values: { ':sourceActivityId': sourceActivityId },
      condition: 'attribute_exists(pk) AND #sourceActivityId = :sourceActivityId',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw error;
  }
}
