import {
  occurrenceMoveMarker as occurrenceMoveMarkerSchema,
  occurrence as occurrenceSchema,
} from '@od/shared/schemas';
import type { Occurrence } from '@od/shared/types';
import {
  batchGetItems,
  deleteItem,
  getItem,
  putItem,
  queryAll,
  queryCount,
} from './base.js';
import { occurrence, occurrenceMoveMarker, occurrenceRange } from './keys.js';
import type { StoredItem } from './migrate.js';
import type { TransactionBuilder } from './tx.js';

const ENTITY = 'Occurrence';
const SCHEMA_VERSION = 1;

type Pair = Readonly<{ activityId: string; date: string }>;

export interface OccurrenceMoveMarker {
  readonly activityId: string;
  readonly destinationDate: string;
  readonly movedFrom: readonly string[];
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
      const marker = occurrenceMoveMarkerSchema.safeParse(row);
      if (!marker.success) continue;
      markers.push({
        activityId: marker.data.activityId,
        destinationDate: marker.data.destinationDate,
        movedFrom: [...new Set(marker.data.movedFrom)].sort(),
      });
    }
  }

  return { occurrences, markers };
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
