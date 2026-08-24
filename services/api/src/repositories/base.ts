import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.js';
import { decodeCursor, encodeCursor, type PageKey } from './cursor.js';
import { type StoredItem, upgradeAll, upgradeOnRead } from './migrate.js';

/**
 * The shared read and write wrappers every repository is built from.
 *
 * Three things live here so that no repository has to remember them, and so that no
 * repository can forget one:
 *
 * 1. **`TableName`.** Supplied once. A repository that passed it per call is a repository
 *    where one call eventually names the wrong table in a way no type catches.
 * 2. **Upgrade-on-read.** Every item that comes back goes through `migrate.ts` before a
 *    caller sees it, so a v1 row in a v2 codebase is a solved problem rather than a
 *    conditional in each repository.
 * 3. **Pagination.** Cursors are encoded and decoded here, so `LastEvaluatedKey` never
 *    escapes this layer and no repository invents its own paging.
 *
 * **There is no `scan` wrapper, and there will not be one.** A `Scan` reads every item in
 * the table, is denied by the Lambda's IAM policy at runtime, and is an automatic review
 * rejection outside `infra/scripts/migrations/` (`data-model.md` §5). The absence is the
 * point: there is nothing here to reach for.
 */

/** A page of results, with the cursor for the next one — absent when there is no next page. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
  /** Present for `Select: COUNT` queries. */
  count?: number;
}

export interface EqualityFilter {
  readonly attribute: string;
  readonly value: unknown;
}

export interface QueryOptions {
  /** `sk begins_with` — the workhorse of this key design. */
  readonly skPrefix?: string;
  /** Inclusive `sk BETWEEN` bounds, for occurrence and date-range reads. */
  readonly skBetween?: readonly [string, string];
  /** Reads the index instead of the table. */
  readonly indexName?: string;
  /** `false` reads newest-first, which is what Needs-a-date and Person history want. */
  readonly ascending?: boolean;
  readonly limit?: number;
  /** The client's opaque cursor, validated against {@link QueryOptions.keyAttributes}. */
  readonly cursor?: string;
  /**
   * The exact key attributes this query pages on. Required whenever `cursor` may be set:
   * it is what stops a cursor minted for one index being replayed against another.
   */
  readonly keyAttributes?: readonly string[];
  /** Repository-owned equality filter; services never supply DynamoDB expressions. */
  readonly filterEquals?: EqualityFilter;
  readonly select?: 'COUNT';
  /** Strong consistency is available only for base-table reads, never a GSI query. */
  readonly consistentRead?: boolean;
}

export interface GetOptions {
  /** Fence reads use strong consistency on the base table. */
  readonly consistentRead?: boolean;
}

/** `GetItem`, upgraded on read. `undefined` when the item is not there. */
export async function getItem<T extends StoredItem>(
  key: PageKey,
  options: GetOptions = {},
): Promise<T | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: key,
      ...(options.consistentRead === true ? { ConsistentRead: true } : {}),
    }),
  );
  return Item === undefined ? undefined : upgradeOnRead(Item as T);
}

/**
 * `PutItem`.
 *
 * `condition` is how a caller expresses "must not already exist"
 * (`attribute_not_exists(pk)`) or an optimistic-concurrency check. It is a parameter rather
 * than a default because the right condition differs per write, and a default would be
 * silently wrong for half of them.
 */
export async function putItem(
  item: StoredItem,
  condition?: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  },
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ...(condition === undefined
        ? {}
        : {
            ConditionExpression: condition.expression,
            ...(condition.names === undefined
              ? {}
              : { ExpressionAttributeNames: condition.names }),
            ...(condition.values === undefined
              ? {}
              : { ExpressionAttributeValues: condition.values }),
          }),
    }),
  );
}

/**
 * `DeleteItem`.
 *
 * `condition` mirrors {@link putItem}'s and exists for the same reason: a delete that must
 * distinguish "removed it" from "there was nothing there" expresses that as
 * `attribute_exists(pk)` and reads the resulting `ConditionalCheckFailedException`, rather
 * than paying for a read before every delete. Absent, the delete is unconditional — which is
 * what a cascade wants, since a cascade has already read the partition it is clearing.
 */
export async function deleteItem(
  key: PageKey,
  condition?: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
  },
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE_NAME,
      Key: key,
      ...(condition === undefined
        ? {}
        : {
            ConditionExpression: condition.expression,
            ...(condition.names === undefined
              ? {}
              : { ExpressionAttributeNames: condition.names }),
            ...(condition.values === undefined
              ? {}
              : { ExpressionAttributeValues: condition.values }),
          }),
    }),
  );
}

/** `UpdateItem`. Returns the updated item, upgraded on read. */
export async function updateItem<T extends StoredItem>(
  key: PageKey,
  update: {
    expression: string;
    names?: Record<string, string>;
    values?: Record<string, unknown>;
    condition?: string;
  },
): Promise<T | undefined> {
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: key,
      UpdateExpression: update.expression,
      ...(update.names === undefined ? {} : { ExpressionAttributeNames: update.names }),
      ...(update.values === undefined
        ? {}
        : { ExpressionAttributeValues: update.values }),
      ...(update.condition === undefined
        ? {}
        : { ConditionExpression: update.condition }),
      ReturnValues: 'ALL_NEW',
    }),
  );
  return Attributes === undefined ? undefined : upgradeOnRead(Attributes as T);
}

/**
 * `Query` — the only read shape this product uses for more than one item.
 *
 * The partition key is always supplied by the caller from `keys.ts`, which is what makes
 * every query tenant-scoped by construction: there is no way to express "query everything"
 * through this function, because there is no parameter for it.
 */
export async function query<T extends StoredItem>(
  partition: { pk: string } | { gsi1pk: string },
  options: QueryOptions = {},
): Promise<Page<T>> {
  const isIndex = 'gsi1pk' in partition;
  if (isIndex && options.consistentRead === true) {
    throw new Error('ConsistentRead is not supported for index queries.');
  }
  const pkAttribute = isIndex ? 'gsi1pk' : 'pk';
  const skAttribute = isIndex ? 'gsi1sk' : 'sk';
  const pkValue = isIndex ? partition.gsi1pk : partition.pk;

  const names: Record<string, string> = { '#pk': pkAttribute };
  const values: Record<string, unknown> = { ':pk': pkValue };
  let condition = '#pk = :pk';

  if (options.skPrefix !== undefined) {
    names['#sk'] = skAttribute;
    values[':skPrefix'] = options.skPrefix;
    condition += ' AND begins_with(#sk, :skPrefix)';
  } else if (options.skBetween !== undefined) {
    names['#sk'] = skAttribute;
    values[':from'] = options.skBetween[0];
    values[':to'] = options.skBetween[1];
    condition += ' AND #sk BETWEEN :from AND :to';
  }

  if (options.filterEquals !== undefined) {
    names['#filter'] = options.filterEquals.attribute;
    values[':filter'] = options.filterEquals.value;
  }

  const startKey = decodeCursor(options.cursor, options.keyAttributes ?? ['pk', 'sk']);

  const result = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      ...(options.indexName === undefined ? {} : { IndexName: options.indexName }),
      ...(options.consistentRead === true ? { ConsistentRead: true } : {}),
      KeyConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ...(options.filterEquals === undefined
        ? {}
        : { FilterExpression: '#filter = :filter' }),
      ...(options.select === undefined ? {} : { Select: options.select }),
      ...(options.ascending === false ? { ScanIndexForward: false } : {}),
      ...(options.limit === undefined ? {} : { Limit: options.limit }),
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    }),
  );

  const nextCursor = encodeCursor(result.LastEvaluatedKey as PageKey | undefined);

  return {
    items: upgradeAll((result.Items ?? []) as T[]),
    ...(result.Count === undefined ? {} : { count: result.Count }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Counts every matching row, following Query pagination internally. */
export async function queryCount(
  partition: { pk: string } | { gsi1pk: string },
  options: Omit<QueryOptions, 'cursor' | 'limit' | 'select'> = {},
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;

  do {
    const page = await query<StoredItem>(partition, {
      ...options,
      select: 'COUNT',
      ...(cursor === undefined ? {} : { cursor }),
      keyAttributes: options.keyAttributes ?? ['pk', 'sk'],
    });
    total += page.count ?? 0;
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return total;
}

/**
 * Reads **every** item in a partition, following pagination internally.
 *
 * For the reads that are bounded by the model rather than by a page size: a plan's own
 * partition (pattern 4), whose size is capped by 50 participants and the item limits, and
 * the delete cascade that has to see all of it. Not for anything a user can grow without
 * bound — those take a cursor and hand it back to the client.
 */
export async function queryAll<T extends StoredItem>(
  partition: { pk: string } | { gsi1pk: string },
  options: Omit<QueryOptions, 'cursor' | 'limit'> = {},
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;

  do {
    const page = await query<T>(partition, {
      ...options,
      ...(cursor === undefined ? {} : { cursor }),
      keyAttributes: options.keyAttributes ?? ['pk', 'sk'],
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return items;
}

/** DynamoDB's `BatchWriteItem` limit. */
export const MAX_BATCH_ITEMS = 25;

/** DynamoDB's `BatchGetItem` key limit. */
export const MAX_BATCH_GET_ITEMS = 100;

const MAX_BATCH_GET_ATTEMPTS = 5;
const BATCH_GET_BACKOFF_BASE_MS = 25;
const BATCH_GET_BACKOFF_CAP_MS = 1_000;

/** Full-jitter delay in [0, exponential ceiling), injectable for a deterministic test. */
export function batchGetBackoffMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(
    BATCH_GET_BACKOFF_CAP_MS,
    BATCH_GET_BACKOFF_BASE_MS * 2 ** attempt,
  );
  return Math.floor(random() * ceiling);
}

/**
 * Gets many items in chunks of 100, retrying the exact unprocessed keys with bounded
 * exponential backoff. Returned order is DynamoDB's; entity repositories restore caller
 * order when that is part of their contract.
 */
export async function batchGetItems<T extends StoredItem>(
  keys: readonly PageKey[],
  options: { readonly consistentRead?: boolean } = {},
): Promise<T[]> {
  const items: T[] = [];

  for (let start = 0; start < keys.length; start += MAX_BATCH_GET_ITEMS) {
    let pending = keys.slice(start, start + MAX_BATCH_GET_ITEMS);

    for (
      let attempt = 0;
      attempt < MAX_BATCH_GET_ATTEMPTS && pending.length > 0;
      attempt += 1
    ) {
      if (attempt > 0) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, batchGetBackoffMs(attempt - 1)),
        );
      }
      const result = await ddb.send(
        new BatchGetCommand({
          RequestItems: {
            [TABLE_NAME]: {
              Keys: pending,
              ...(options.consistentRead === true ? { ConsistentRead: true } : {}),
            },
          },
        }),
      );
      items.push(...upgradeAll((result.Responses?.[TABLE_NAME] ?? []) as T[]));
      pending = (result.UnprocessedKeys?.[TABLE_NAME]?.Keys ?? []) as PageKey[];
    }

    if (pending.length > 0) {
      const error = new Error(
        `BatchGetItem left ${pending.length} keys unprocessed after ${MAX_BATCH_GET_ATTEMPTS} attempts.`,
      );
      // Deliberately impersonate the AWS throttle name so the central handler returns retryable 503.
      error.name = 'ProvisionedThroughputExceededException';
      throw error;
    }
  }

  return items;
}

/**
 * Deletes many keys in batches of 25.
 *
 * **Not atomic, and that is the right trade for a cascade.** A partition with more than 100
 * items exceeds a transaction, and a transaction that can never succeed leaves the user
 * unable to delete anything; a partially deleted activity is recoverable by re-running the
 * delete, which is why P1-14's handler is idempotent.
 *
 * Unprocessed keys are retried — `BatchWriteItem` returns them rather than failing, and a
 * caller that ignored `UnprocessedItems` would leave rows behind under throttling and call
 * the delete a success.
 */
export async function deleteAll(keys: readonly PageKey[]): Promise<void> {
  for (let start = 0; start < keys.length; start += MAX_BATCH_ITEMS) {
    let pending = keys.slice(start, start + MAX_BATCH_ITEMS).map((Key) => ({
      DeleteRequest: { Key },
    }));

    // Bounded so a persistently throttled table fails loudly instead of looping forever.
    for (let attempt = 0; attempt < 5 && pending.length > 0; attempt += 1) {
      const result = await ddb.send(
        new BatchWriteCommand({ RequestItems: { [TABLE_NAME]: pending } }),
      );
      pending = (result.UnprocessedItems?.[TABLE_NAME] ?? []) as typeof pending;
    }

    if (pending.length > 0) {
      throw new Error(
        `BatchWriteItem left ${pending.length} keys unprocessed after 5 attempts.`,
      );
    }
  }
}
