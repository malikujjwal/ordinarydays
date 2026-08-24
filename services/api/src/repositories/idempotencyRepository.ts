import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.js';
import {
  type CleanupPhase,
  type CleanupRef,
  type CleanupWork,
  IdempotencyRaceError,
  type IdempotencyReceipt,
} from '../lib/idempotency.js';
import { cleanup, cleanupPrefix, idempotency } from './keys.js';
import type { TransactItem } from './tx.js';

/** Stored successful response. There is deliberately no durable in-flight shape. */
export type IdempotencyRecord = IdempotencyReceipt;

/** Conditional receipt put appended to the same transaction as the domain write. */
export function receiptItem(receipt: IdempotencyReceipt): TransactItem {
  return {
    Put: {
      Item: {
        ...idempotency(receipt.userId, receipt.key),
        entity: 'Idempotency',
        ...receipt,
        updatedAt: receipt.createdAt,
        schemaVersion: 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

/**
 * Writes the receipt on its own, for an operation that turned out to have nothing left to do.
 *
 * The one caller is P3-08's bulk replay: after the original receipt expires, a batch whose
 * every stable item id is already committed writes no domain rows, and without this the
 * operation would record no receipt and re-resolve the whole batch on the next replay. The
 * conditional put is the same one {@link receiptItem} contributes to a transaction, so a
 * concurrent first attempt still races on it rather than overwriting a committed response.
 */
export async function writeReceiptOnly(receipt: IdempotencyReceipt): Promise<void> {
  const item = receiptItem(receipt).Put;
  if (item === undefined) throw new Error('receiptItem produced no Put.');
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item.Item,
        ConditionExpression: item.ConditionExpression as string,
      }),
    );
  } catch (error) {
    /**
     * A concurrent first attempt won this key. Raised as the typed race — exactly as a
     * transactional receipt failure is — so the middleware reads the winner's committed
     * record and returns it. Left raw, the SDK's conditional failure would map to a bare
     * `409` and the loser would never see the response it was entitled to.
     */
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new IdempotencyRaceError();
    }
    throw error;
  }
}

/** Durable remaining phases, committed atomically with main state and the receipt. */
export function cleanupItem(work: CleanupWork): TransactItem {
  return {
    Put: {
      Item: {
        ...cleanup(work.activityId, work.userId, work.idempotencyKey),
        entity: 'CleanupWork',
        ...work,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    },
  };
}

/** Strong reads are required after a cancelled contender observes the winner's commit. */
export async function loadReceipt(
  userId: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const result = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: idempotency(userId, key),
      ConsistentRead: true,
    }),
  );
  const Item = result?.Item;
  if (
    Item === undefined ||
    typeof Item.body !== 'string' ||
    typeof Item.status !== 'number'
  ) {
    return undefined;
  }
  return Item as unknown as IdempotencyRecord;
}

export async function loadCleanup(ref: CleanupRef): Promise<CleanupWork | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: cleanup(ref.activityId, ref.userId, ref.idempotencyKey),
      ConsistentRead: true,
    }),
  );
  return Item === undefined ? undefined : (Item as unknown as CleanupWork);
}

/** Strong query used by the before-next-same-Activity recovery path. */
export async function listCleanup(activityId: string): Promise<CleanupWork[]> {
  const prefix = cleanupPrefix(activityId);
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: { ':pk': prefix.pk, ':sk': prefix.skPrefix },
      ConsistentRead: true,
    }),
  );
  return Items as unknown as CleanupWork[];
}

/**
 * Persists one idempotent phase step. Comparing the full prior phase list prevents concurrent
 * drains from moving a cursor backwards even when two timestamp strings happen to match.
 */
export async function saveCleanupProgress(
  work: CleanupWork,
  phases: readonly CleanupPhase[],
  updatedAt: string,
): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: cleanup(work.activityId, work.userId, work.idempotencyKey),
        UpdateExpression: 'SET phases = :phases, updatedAt = :next',
        ConditionExpression: 'phases = :previousPhases',
        ExpressionAttributeValues: {
          ':phases': phases,
          ':next': updatedAt,
          ':previousPhases': work.phases,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

/** Deletes only the exact completed version; a racing worker may already have done so. */
export async function deleteCleanup(work: CleanupWork): Promise<boolean> {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: cleanup(work.activityId, work.userId, work.idempotencyKey),
        ConditionExpression: 'updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':updatedAt': work.updatedAt },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}
