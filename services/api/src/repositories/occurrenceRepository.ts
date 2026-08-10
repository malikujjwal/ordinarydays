import { occurrence as occurrenceSchema } from '@od/shared/schemas';
import type { Occurrence } from '@od/shared/types';
import {
  batchGetItems,
  deleteItem,
  getItem,
  putItem,
  queryAll,
  queryCount,
} from './base.js';
import { occurrence, occurrenceRange } from './keys.js';
import type { StoredItem } from './migrate.js';

const ENTITY = 'Occurrence';
const SCHEMA_VERSION = 1;

type Pair = Readonly<{ activityId: string; date: string }>;

const parseOccurrence = (item: unknown): Occurrence =>
  occurrenceSchema.parse(item) as Occurrence;

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
  const byPair = new Map(
    rows.map((row) => {
      const parsed = parseOccurrence(row);
      return [`${parsed.activityId}\u0000${parsed.date}`, parsed] as const;
    }),
  );

  return pairs.map((pair) => byPair.get(`${pair.activityId}\u0000${pair.date}`) ?? null);
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
export async function put(value: Occurrence): Promise<void> {
  const now = new Date().toISOString();
  await putItem({
    ...occurrence(value.activityId, value.date),
    entity: ENTITY,
    ...value,
    createdAt: now,
    updatedAt: now,
    schemaVersion: SCHEMA_VERSION,
  });
}

/** Removing an override restores the implicit scheduled state. */
async function deleteOccurrence(activityId: string, date: string): Promise<void> {
  await deleteItem(occurrence(activityId, date));
}

export { deleteOccurrence as delete };

/** Real stored completion count for whole-series deletion copy. */
export async function countCompleted(activityId: string): Promise<number> {
  const prefix = occurrenceRange(activityId, '', '');
  return queryCount(
    { pk: prefix.pk },
    { skPrefix: 'OCC#', filterEquals: { attribute: 'status', value: 'completed' } },
  );
}

/** Name retained for the Phase 1 caller while ownership moves to this repository. */
export const listOccurrences = queryWindow;
