import {
  occurrenceMoveMarker as occurrenceMoveMarkerSchema,
  occurrence as occurrenceSchema,
} from '@od/shared/schemas';
import type { Occurrence } from '@od/shared/types';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import {
  batchGetItems,
  deleteItem,
  getItem,
  putItem,
  queryAll,
  queryCount,
} from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import { occurrence, occurrenceMoveMarker, occurrenceRange } from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';

const ENTITY = 'Occurrence';
const SCHEMA_VERSION = 1;

type Pair = Readonly<{ activityId: string; date: string }>;

export interface OccurrenceMoveMarker {
  readonly activityId: string;
  readonly destinationDate: string;
  readonly movedFrom: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

function parseOccurrence(value: unknown): Occurrence {
  const parsed = occurrenceSchema.parse(value);
  // Zod models optional keys as value | undefined; exactOptionalPropertyTypes models absence.
  return parsed as Occurrence;
}

/** The sole DynamoDB owner of `ACT#<id>` / `OCC#<nominal-date>` rows. */
export async function get(activityId: string, date: string): Promise<Occurrence | null> {
  const item = await getItem<StoredItem>(occurrence(activityId, date));
  return item === undefined ? null : parseOccurrence(item);
}

/**
 * Hydrates overrides in one bounded BatchGet path and restores the caller's pair order.
 * Misses remain `null`, so a service never has to infer which requested key was absent.
 */
export async function batchGetForPairs(
  pairs: readonly Pair[],
): Promise<(Occurrence | null)[]> {
  const unique = new Map<string, Pair>();
  for (const pair of pairs) unique.set(`${pair.activityId}\u0000${pair.date}`, pair);

  const rows = await batchGetItems<StoredItem>(
    [...unique.values()].map((pair) => occurrence(pair.activityId, pair.date)),
  );
  const byPair = new Map<string, Occurrence>();
  for (const row of rows) {
    const parsed = parseOccurrence(row);
    byPair.set(`${parsed.activityId}\u0000${parsed.date}`, parsed);
  }

  return pairs.map((pair) => byPair.get(`${pair.activityId}\u0000${pair.date}`) ?? null);
}

/** First agenda pass: nominal overrides and destination move markers in one BatchGet. */
export async function batchGetAgendaRows(
  occurrencePairs: readonly Pair[],
  markerPairs: readonly Pair[],
): Promise<{
  occurrences: Occurrence[];
  markers: OccurrenceMoveMarker[];
}> {
  const requested = [
    ...occurrencePairs.map((pair) => occurrence(pair.activityId, pair.date)),
    ...markerPairs.map((pair) => occurrenceMoveMarker(pair.activityId, pair.date)),
  ];
  const keys = [
    ...new Map(requested.map((key) => [`${key.pk}\u0000${key.sk}`, key])).values(),
  ];
  const rows = await batchGetItems<StoredItem>(keys);
  const occurrences: Occurrence[] = [];
  const markers: OccurrenceMoveMarker[] = [];

  for (const row of rows) {
    if (row.entity === ENTITY) {
      occurrences.push(parseOccurrence(row));
      continue;
    }
    if (row.entity === 'OccurrenceMoveMarker') {
      const marker = parseMoveMarker(row);
      if (marker !== null) markers.push(marker);
    }
  }

  return { occurrences, markers };
}

function parseMoveMarker(value: unknown): OccurrenceMoveMarker | null {
  const marker = occurrenceMoveMarkerSchema.safeParse(value);
  if (!marker.success) return null;
  const stored = value as StoredItem;
  return {
    activityId: marker.data.activityId,
    destinationDate: marker.data.destinationDate,
    movedFrom: [...new Set(marker.data.movedFrom)].sort(),
    ...(typeof stored.createdAt === 'string' ? { createdAt: stored.createdAt } : {}),
    ...(typeof stored.updatedAt === 'string' ? { updatedAt: stored.updatedAt } : {}),
  };
}

/** Reads one destination marker so a version-checked update cannot lose another move. */
export async function getMoveMarker(
  activityId: string,
  destinationDate: string,
): Promise<OccurrenceMoveMarker | null> {
  const item = await getItem<StoredItem>(
    occurrenceMoveMarker(activityId, destinationDate),
  );
  return item === undefined ? null : parseMoveMarker(item);
}

/** Replaces a destination marker while checking the version observed by the service. */
export function putMoveMarker(
  value: OccurrenceMoveMarker,
  previous: OccurrenceMoveMarker | null,
  now: string,
  transaction: TransactionBuilder,
): void {
  const key = occurrenceMoveMarker(value.activityId, value.destinationDate);
  transaction.add({
    Put: {
      Item: {
        ...key,
        entity: 'OccurrenceMoveMarker',
        activityId: value.activityId,
        destinationDate: value.destinationDate,
        movedFrom: [...new Set(value.movedFrom)].sort(),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION,
      },
      ConditionExpression:
        previous === null ? 'attribute_not_exists(pk)' : '#updatedAt = :expected',
      ...(previous === null
        ? {}
        : {
            ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
            ExpressionAttributeValues: { ':expected': previous.updatedAt },
          }),
    },
  });
}

/** Deletes the marker only if no concurrent writer changed the observed reference set. */
export function deleteMoveMarker(
  value: OccurrenceMoveMarker,
  transaction: TransactionBuilder,
): void {
  transaction.add({
    Delete: {
      Key: occurrenceMoveMarker(value.activityId, value.destinationDate),
      ConditionExpression: '#updatedAt = :expected',
      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: { ':expected': value.updatedAt },
    },
  });
}

/** Inclusive nominal-date window for one recurring series (access pattern 5). */
export async function queryWindow(
  activityId: string,
  from: string,
  to: string,
): Promise<Occurrence[]> {
  const range = occurrenceRange(activityId, from, to);
  const rows = await queryAll<StoredItem>(
    { pk: range.pk },
    { skBetween: [range.fromSk, range.toSk] },
  );
  return rows.map(parseOccurrence);
}

/** Upserts exactly one override row and cannot touch the series META item. */
export async function put(
  value: Occurrence,
  transaction?: TransactionBuilder,
): Promise<void> {
  const now = new Date().toISOString();
  const item = {
    ...occurrence(value.activityId, value.date),
    entity: ENTITY,
    ...value,
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
  if (transaction !== undefined) {
    transaction.add({ Put: { Item: item } });
    return;
  }
  await putItem(item);
}

/** Removing an override restores the implicit scheduled state. */
async function deleteOccurrence(
  activityId: string,
  date: string,
  transaction?: TransactionBuilder,
): Promise<void> {
  if (transaction !== undefined) {
    transaction.add({ Delete: { Key: occurrence(activityId, date) } });
    return;
  }
  await deleteItem(occurrence(activityId, date));
}

export { deleteOccurrence as delete };

export interface OccurrenceScheduleWrite {
  readonly activityId: string;
  readonly sourceDate: string;
  readonly value: Occurrence | null;
  readonly oldDestination?: string;
  readonly oldMarker?: OccurrenceMoveMarker | null;
  readonly newDestination?: string;
  readonly newMarker?: OccurrenceMoveMarker | null;
  readonly receipt: IdempotencyReceipt;
  readonly now: string;
}

/** Writes the nominal override, marker replacement/removal, and receipt in one transaction. */
export async function writeOccurrenceSchedule(
  input: OccurrenceScheduleWrite,
): Promise<void> {
  const builder = new TransactionBuilder('writeOccurrenceSchedule', 1);
  if (input.value === null) {
    builder.add({ Delete: { Key: occurrence(input.activityId, input.sourceDate) } });
  } else {
    builder.add({
      Put: {
        Item: {
          ...occurrence(input.activityId, input.sourceDate),
          entity: ENTITY,
          ...input.value,
          createdAt: input.now,
          updatedAt: input.now,
          schemaVersion: SCHEMA_VERSION,
        },
      },
    });
  }

  if (
    input.oldDestination !== undefined &&
    input.oldDestination !== input.newDestination
  ) {
    const remaining = (input.oldMarker?.movedFrom ?? []).filter(
      (date) => date !== input.sourceDate,
    );
    builder.add(
      remaining.length === 0
        ? {
            Delete: { Key: occurrenceMoveMarker(input.activityId, input.oldDestination) },
          }
        : {
            Put: {
              Item: markerItem(
                input.activityId,
                input.oldDestination,
                remaining,
                input.now,
              ),
            },
          },
    );
  }

  if (input.newDestination !== undefined) {
    const movedFrom = [
      ...(input.newMarker?.movedFrom ?? []).filter((date) => date !== input.sourceDate),
      input.sourceDate,
    ].sort();
    builder.add({
      Put: {
        Item: markerItem(input.activityId, input.newDestination, movedFrom, input.now),
      },
    });
  }

  const receiptIndex = builder.length;
  builder.addReserved(receiptItem(input.receipt));
  await transactWrite(builder.build(), {
    operation: 'writeOccurrenceSchedule',
    onConditionFailed: (index) =>
      index === receiptIndex ? new IdempotencyRaceError() : undefined,
  });
}

function markerItem(
  activityId: string,
  destinationDate: string,
  movedFrom: readonly string[],
  now: string,
): StoredItem {
  return {
    ...occurrenceMoveMarker(activityId, destinationDate),
    entity: 'OccurrenceMoveMarker',
    activityId,
    destinationDate,
    movedFrom: [...new Set(movedFrom)].sort(),
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * Real stored completion count consumed by the whole-series delete-confirmation copy.
 */
export async function countCompleted(activityId: string): Promise<number> {
  const prefix = occurrenceRange(activityId, '', '');
  return queryCount(
    { pk: prefix.pk },
    { skPrefix: 'OCC#', filterEquals: { attribute: 'status', value: 'completed' } },
  );
}

/** Name retained for the Phase 1 caller while ownership moves to this repository. */
export const listOccurrences = queryWindow;
