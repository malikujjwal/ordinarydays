import { type LegacyListAggregate, migrateLegacyListAggregate } from '@od/shared/lists';
import type { List } from '@od/shared/types';
import { z } from 'zod';
import { getItem, query } from './base.js';
import { listItemPrefix, listMeta, listSchemaMigration, listTombstone } from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';

const OPERATION_ID = 'schema_v2';
const CHUNK_SIZE = 40;

type LegacyList = LegacyListAggregate['list'];
type LegacyItem = LegacyListAggregate['items'][number];

interface ListSchemaMigrationWork {
  readonly listId: string;
  readonly operationId: typeof OPERATION_ID;
  readonly legacyList: LegacyList;
  readonly createdAt: string;
  readonly cursor?: string;
  readonly doneCount: number;
  readonly complete: boolean;
}

const workSchema = z.object({
  listId: z.string().min(1),
  operationId: z.literal(OPERATION_ID),
  legacyList: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  cursor: z.string().min(1).optional(),
  doneCount: z.number().int().nonnegative(),
  complete: z.boolean(),
});

export function hasCanonicalListShape(row: StoredItem): boolean {
  return (
    row.schemaVersion === 2 &&
    row.itemStateMode !== undefined &&
    row.featureConfig !== undefined &&
    row.doneCount !== undefined
  );
}

export function isCanonicalListRow(row: StoredItem): boolean {
  return hasCanonicalListShape(row) && row.schemaMigrationId === undefined;
}

function legacyListFromRow(row: StoredItem): LegacyList {
  return {
    listId: String(row.listId),
    ownerId: row.ownerId as LegacyList['ownerId'],
    behaviour: row.behaviour as LegacyList['behaviour'],
    templateKey: String(row.templateKey),
    title: String(row.title),
    icon: String(row.icon),
    emptyStateCopy: String(row.emptyStateCopy),
    capabilities: row.capabilities as LegacyList['capabilities'],
    slot: row.slot as LegacyList['slot'],
    ...(row.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: String(row.sourceActivityId) }),
    itemCount: Number(row.itemCount),
    uncheckedCount: Number(row.uncheckedCount),
    memberCount: Number(row.memberCount),
    rankVersion: Number(row.rankVersion),
    ...(row.itemVersion === undefined ? {} : { itemVersion: Number(row.itemVersion) }),
    ...(row.rankRepairId === undefined ? {} : { rankRepairId: String(row.rankRepairId) }),
    archived: Boolean(row.archived),
    updatedAt: String(row.updatedAt),
    lastItemActivityAt: String(row.lastItemActivityAt),
  };
}

function legacyItemFromRow(row: StoredItem): LegacyItem {
  return {
    itemId: String(row.itemId),
    listId: String(row.listId),
    rank: String(row.rank),
    itemRevision: Number(row.itemRevision),
    title: String(row.title),
    ...(row.note === undefined ? {} : { note: String(row.note) }),
    checked: Boolean(row.checked),
    ...(row.location === undefined
      ? {}
      : { location: row.location as LegacyItem['location'] }),
    ...(row.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: String(row.sourceActivityId) }),
    ...(row.sourceLabel === undefined ? {} : { sourceLabel: String(row.sourceLabel) }),
    ...(row.sourceProvenance === undefined
      ? {}
      : { sourceProvenance: row.sourceProvenance as LegacyItem['sourceProvenance'] }),
    ...(row.details === undefined
      ? {}
      : { details: row.details as LegacyItem['details'] }),
  } as LegacyItem;
}

function workItem(work: ListSchemaMigrationWork, now: string): StoredItem {
  return {
    ...listSchemaMigration(work.listId, work.operationId),
    entity: 'ListSchemaMigration',
    schemaVersion: 2,
    updatedAt: now,
    ...work,
  };
}

async function begin(listId: string, row: StoredItem): Promise<ListSchemaMigrationWork> {
  const work: ListSchemaMigrationWork = {
    listId,
    operationId: OPERATION_ID,
    legacyList: legacyListFromRow(row),
    createdAt: String(row.createdAt ?? row.updatedAt),
    doneCount: 0,
    complete: false,
  };

  await transactWrite(
    new TransactionBuilder('beginListSchemaMigration')
      .add(
        {
          ConditionCheck: {
            Key: listTombstone(listId),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Update: {
            Key: listMeta(listId),
            UpdateExpression: 'SET #schemaMigrationId = :operationId',
            ConditionExpression:
              '#updatedAt = :updatedAt AND #rankVersion = :rankVersion AND attribute_not_exists(#rankRepairId) AND attribute_not_exists(#schemaMigrationId)',
            ExpressionAttributeNames: {
              '#updatedAt': 'updatedAt',
              '#rankVersion': 'rankVersion',
              '#rankRepairId': 'rankRepairId',
              '#schemaMigrationId': 'schemaMigrationId',
            },
            ExpressionAttributeValues: {
              ':updatedAt': work.legacyList.updatedAt,
              ':rankVersion': work.legacyList.rankVersion,
              ':operationId': OPERATION_ID,
            },
          },
        },
        {
          Put: {
            Item: workItem(work, work.createdAt),
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      )
      .build(),
    { operation: 'beginListSchemaMigration' },
  );
  return work;
}

async function persistedWork(listId: string): Promise<ListSchemaMigrationWork> {
  const row = await getItem<StoredItem>(listSchemaMigration(listId, OPERATION_ID), {
    consistentRead: true,
  });
  if (row === undefined) {
    throw new Error('A List schema migration marker has no work record.');
  }
  const parsed = workSchema.parse(row);
  return parsed as unknown as ListSchemaMigrationWork;
}

async function applyChunk(
  work: ListSchemaMigrationWork,
): Promise<ListSchemaMigrationWork> {
  const prefix = listItemPrefix(work.listId);
  const page = await query<StoredItem>(
    { pk: prefix.pk },
    {
      skPrefix: prefix.skPrefix,
      consistentRead: true,
      limit: CHUNK_SIZE,
      ...(work.cursor === undefined ? {} : { cursor: work.cursor }),
      keyAttributes: ['pk', 'sk'],
    },
  );
  const converted = migrateLegacyListAggregate({
    list: work.legacyList,
    items: page.items.map(legacyItemFromRow),
  });
  const migratedRows = converted.items.map((item, index) => {
    const before = page.items[index] as StoredItem;
    return {
      pk: before.pk,
      sk: before.sk,
      entity: 'ListItem',
      schemaVersion: 2,
      createdAt: before.createdAt ?? work.createdAt,
      updatedAt: before.updatedAt ?? work.legacyList.updatedAt,
      ...item,
    } satisfies StoredItem;
  });
  const addedDone = converted.items.filter((item) => item.state === 'done').length;
  const next: ListSchemaMigrationWork = {
    ...work,
    ...(page.nextCursor === undefined ? { complete: true } : { cursor: page.nextCursor }),
    doneCount: work.doneCount + addedDone,
  };

  const cursorCondition =
    work.cursor === undefined
      ? 'attribute_not_exists(#cursor)'
      : '#cursor = :expectedCursor';
  const builder = new TransactionBuilder('applyListSchemaMigrationChunk').add({
    ConditionCheck: {
      Key: listMeta(work.listId),
      ConditionExpression: '#schemaMigrationId = :operationId',
      ExpressionAttributeNames: { '#schemaMigrationId': 'schemaMigrationId' },
      ExpressionAttributeValues: { ':operationId': work.operationId },
    },
  });
  for (let index = 0; index < migratedRows.length; index += 1) {
    const before = page.items[index] as StoredItem;
    builder.add({
      Put: {
        Item: migratedRows[index],
        ConditionExpression: '#itemRevision = :itemRevision',
        ExpressionAttributeNames: { '#itemRevision': 'itemRevision' },
        ExpressionAttributeValues: { ':itemRevision': before.itemRevision },
      },
    });
  }
  builder.add({
    Update: {
      Key: listSchemaMigration(work.listId, work.operationId),
      UpdateExpression:
        page.nextCursor === undefined
          ? 'SET #doneCount = :doneCount, #complete = :true REMOVE #cursor'
          : 'SET #doneCount = :doneCount, #cursor = :nextCursor',
      ConditionExpression: `${cursorCondition} AND #doneCount = :expectedDoneCount`,
      ExpressionAttributeNames: {
        '#cursor': 'cursor',
        '#doneCount': 'doneCount',
        '#complete': 'complete',
      },
      ExpressionAttributeValues: {
        ':expectedDoneCount': work.doneCount,
        ':doneCount': next.doneCount,
        ':true': true,
        ...(work.cursor === undefined ? {} : { ':expectedCursor': work.cursor }),
        ...(page.nextCursor === undefined ? {} : { ':nextCursor': page.nextCursor }),
      },
    },
  });
  await transactWrite(builder.build(), { operation: 'applyListSchemaMigrationChunk' });
  return next;
}

function canonicalMeta(work: ListSchemaMigrationWork): StoredItem {
  const converted = migrateLegacyListAggregate({ list: work.legacyList, items: [] });
  const list: List = { ...converted.list, doneCount: work.doneCount };
  return {
    ...listMeta(work.listId),
    entity: 'List',
    createdAt: work.createdAt,
    ...list,
  };
}

async function finish(work: ListSchemaMigrationWork): Promise<StoredItem> {
  const meta = canonicalMeta(work);
  await transactWrite(
    new TransactionBuilder('finishListSchemaMigration')
      .add(
        {
          Put: {
            Item: meta,
            ConditionExpression: '#schemaMigrationId = :operationId',
            ExpressionAttributeNames: { '#schemaMigrationId': 'schemaMigrationId' },
            ExpressionAttributeValues: { ':operationId': work.operationId },
          },
        },
        { Delete: { Key: listSchemaMigration(work.listId, work.operationId) } },
      )
      .build(),
    { operation: 'finishListSchemaMigration' },
  );
  return meta;
}

/**
 * Converts a legacy aggregate behind a durable marker. Each item page and its cursor land in
 * one transaction, so a process exit repeats at most one conditionally fenced page.
 */
export async function migrateListAggregateOnRead(
  listId: string,
  row: StoredItem,
): Promise<StoredItem> {
  if (isCanonicalListRow(row)) return row;
  let work =
    row.schemaMigrationId === undefined
      ? await begin(listId, row)
      : await persistedWork(listId);
  while (!work.complete) work = await applyChunk(work);
  return finish(work);
}
