import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.js';
import { idempotency } from './keys.js';

/**
 * The idempotency record (`data-model.md` §3.4, `api-contract.md` §1, P1-04).
 *
 * A repository rather than direct calls from the middleware, because nothing under
 * `middleware/` may reach `lib/ddb.ts` — `dependency-cruiser` resolves the real module graph
 * and rejects it however many hops it takes, and `check-forbidden.mjs no-key-literals`
 * rejects the key string outside this layer. P1-04's file list names only the middleware;
 * the layering rule makes this file mandatory regardless.
 *
 * ## The item has two states, and the difference is the whole design
 *
 * A **reservation** is written before the handler runs, with `attribute_not_exists(pk)`. A
 * **completed** record is the same item with the response attached, written after the
 * handler succeeds. That ordering is what makes two concurrent requests with the same key
 * safe: the loser of the conditional write learns it lost *before* either handler has
 * created anything, rather than after both have.
 *
 * A record with no `body` is therefore not "missing" — it means a request with this key is
 * in flight right now, which is a different answer and gets a different status (409).
 */

/** 24 hours (`api-contract.md` §1). Long enough for a phone to retry, short enough to expire. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export interface IdempotencyRecord {
  /** The route that created it, so a key reused on a different route is visible in the item. */
  readonly route: string;
  readonly userId: string;
  /** The stored response body, verbatim. Absent while the request is still in flight. */
  readonly body?: string;
  /** The status the original handler returned. Absent while in flight. */
  readonly status?: number;
}

export type ReservationResult =
  /** This caller owns the key and should run the handler. */
  | { readonly kind: 'reserved' }
  /** A previous request with this key finished. Replay its response. */
  | { readonly kind: 'replay'; readonly record: IdempotencyRecord }
  /** A request with this key is running right now, and has not stored a response yet. */
  | { readonly kind: 'in-flight' };

/**
 * Claims the key, or reports who already has it.
 *
 * The conditional put is the entire concurrency control. Two in-flight requests with the
 * same key both attempt it; exactly one succeeds, and the loser re-reads to find out whether
 * the winner has finished. There is deliberately no read-then-write path, because that is
 * the race this exists to close.
 */
export async function reserve(
  userId: string,
  key: string,
  route: string,
  nowMs: number,
): Promise<ReservationResult> {
  const dbKey = idempotency(userId, key);

  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...dbKey,
          entity: 'Idempotency',
          route,
          userId,
          ttl: Math.floor(nowMs / 1000) + IDEMPOTENCY_TTL_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return { kind: 'reserved' };
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
      /**
       * Not the condition — a throttle, a network fault, a missing table. Rethrown rather
       * than allowed through, unlike the rate limiter: allowing here would run the handler
       * with no reservation held, which is precisely the duplicate create this middleware
       * exists to prevent. The handler would almost certainly fail on the same table anyway.
       */
      throw error;
    }

    const existing = await load(userId, key);
    // The item vanished between the failed put and this read — its TTL expired in the
    // window, which is rare but not impossible. Treat it as in flight rather than inventing
    // a replay from nothing.
    if (existing?.body === undefined || existing.status === undefined) {
      return { kind: 'in-flight' };
    }
    return { kind: 'replay', record: existing };
  }
}

/** Reads the record, or `undefined` when the key has never been used (or has expired). */
export async function load(
  userId: string,
  key: string,
): Promise<IdempotencyRecord | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: idempotency(userId, key) }),
  );
  return Item === undefined ? undefined : (Item as unknown as IdempotencyRecord);
}

/**
 * Attaches the response to an existing reservation.
 *
 * `SET` on the reserved item rather than a fresh `Put`, so the `ttl` written at reservation
 * time is preserved: the 24 hours run from when the key was first seen, not from when the
 * handler happened to finish.
 */
export async function complete(
  userId: string,
  key: string,
  status: number,
  body: string,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: idempotency(userId, key),
      UpdateExpression: 'SET #body = :body, #status = :status',
      // `status` is a DynamoDB reserved word; `body` is not, but is aliased for symmetry.
      ExpressionAttributeNames: { '#body': 'body', '#status': 'status' },
      ExpressionAttributeValues: { ':body': body, ':status': status },
    }),
  );
}

/**
 * Drops a reservation whose handler failed.
 *
 * **Only successful responses are stored** (P1-04). Without this, a `500` would hold the key
 * for 24 hours and the client's retry — the entire reason it sent a key — would come back
 * `409` until tomorrow. The failure is what the caller wanted to retry, so the key must be
 * free the moment it is known to have failed.
 */
export async function release(userId: string, key: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: idempotency(userId, key) }),
  );
}
