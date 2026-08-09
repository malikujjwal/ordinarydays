import { createHash } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from '../lib/ddb.js';
import { rateLimit } from './keys.js';

/**
 * The fixed-window rate-limit counter (`data-model.md` §3.4, `security-privacy.md` §5).
 *
 * One item per (scope, subject, window), incremented atomically and deleted by TTL when the
 * window ends. One write request unit — the limiter costs less than the request it prevents.
 *
 * ## Why the limit is a condition rather than a read
 *
 * `GetItem` then decide then `UpdateItem` is two round trips **and** a race: two concurrent
 * requests both read 119, both decide they are under, and both write. Putting the limit in a
 * `ConditionExpression` makes the check and the increment one atomic operation, so the
 * counter can never exceed the limit no matter how many Lambdas run at once
 * (`security-privacy.md` §5: `ADD #n :one` with `#n < :limit`).
 *
 * The consequence for callers: **being over the limit arrives as a thrown
 * `ConditionalCheckFailedException`, not as a return value.** {@link consume} converts it to
 * a `false`, so no caller has to know that.
 */

/** `RATE#<scope>#<subject>` distinguishes the buckets, so an hourly counter never shares. */
export type RateLimitScope = 'general' | 'capture' | 'upload-url' | 'public';

export interface RateLimitRule {
  readonly scope: RateLimitScope;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  /** Seconds until the window ends. Sent as `Retry-After` when refused. */
  readonly retryAfterSeconds: number;
  /**
   * `true` when DynamoDB failed for a reason that is **not** the limit.
   *
   * The caller allows the request and logs. A rate limiter that takes the API down is worse
   * than one that occasionally lets a request through (P1-03).
   */
  readonly degraded: boolean;
}

/**
 * The window this instant falls in, as epoch seconds, floored to the window size.
 *
 * A fixed window rather than a sliding one, which permits a 2× burst across a boundary. That
 * is acceptable at these limits and is far simpler; **do not build a token bucket** (P1-03).
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the boundary behaviour is
 * testable without waiting for a real minute to pass (`coding-standards.md` §4.3).
 */
export function windowStartSeconds(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;
}

/**
 * Hashes a value that must not be stored in the clear — the client IP, today.
 *
 * **`salt` is required and has no default.** An unsalted SHA-256 of an IPv4 address is
 * reversible: the whole space is 2^32 and enumerating it is minutes of compute, so an
 * unsalted digest *is* the address and `security-privacy.md` §3's claim that raw addresses
 * never enter the table would be true only in the letter. Making the parameter required
 * means a caller cannot omit it by accident; there is deliberately no `salt = ''` fallback.
 *
 * Nothing calls this yet. The public per-IP limit is the only user, `/public/v1/*` routes
 * arrive in Phase 6, and where the salt itself comes from is an open decision — see the note
 * on `PUBLIC_PER_IP` in `../middleware/rateLimit.ts`.
 */
export function hashSubject(value: string, salt: string): string {
  if (salt === '') throw new Error('A rate-limit subject hash needs a non-empty salt.');
  return createHash('sha256').update(`${value}${salt}`).digest('hex');
}

/**
 * Increments the counter and reports whether the request may proceed.
 *
 * Never throws for a limit breach and never throws for a DynamoDB fault: the two are
 * distinguished here and both come back as an outcome, because the middleware's decision
 * ("refuse" vs "allow and log") is different for each and neither should be an exception the
 * request pipeline has to catch.
 */
export async function consume(
  rule: RateLimitRule,
  subject: string,
  nowMs: number,
): Promise<RateLimitOutcome> {
  const start = windowStartSeconds(nowMs, rule.windowSeconds);
  const end = start + rule.windowSeconds;
  const retryAfterSeconds = Math.max(1, end - Math.floor(nowMs / 1000));

  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: rateLimit(rule.scope, subject, String(start)),
        /**
         * `ADD` creates the attribute at 0 and increments in one operation, so there is no
         * separate "first request in this window" path to get wrong. `ttl` is set on every
         * write rather than only the first: the value is identical for every request in a
         * window, so a redundant assignment is cheaper than a conditional one.
         */
        UpdateExpression: 'SET #ttl = :ttl ADD #n :one',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
        ExpressionAttributeNames: { '#n': 'count', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':limit': rule.limit,
          ':ttl': end,
        },
      }),
    );
    return { allowed: true, retryAfterSeconds, degraded: false };
  } catch (error) {
    // The limit, arriving as an exception because the check is a condition.
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return { allowed: false, retryAfterSeconds, degraded: false };
    }
    // Anything else — throttling, a network fault, a missing table. Allow and let the
    // caller log it.
    return { allowed: true, retryAfterSeconds, degraded: true };
  }
}
