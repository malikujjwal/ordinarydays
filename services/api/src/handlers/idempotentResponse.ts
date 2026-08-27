import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import {
  type CleanupRef,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyReceipt,
} from '../lib/idempotency.js';

type SuccessStatus = 200 | 201 | 202 | 204;

export interface IdempotentJsonOptions {
  /** Overrides the ordinary 24-hour receipt window for a longer-lived response contract. */
  readonly receiptTtlSeconds?: number;
}

/**
 * Precomputes the successful HTTP body before the domain transaction commits.
 *
 * The operation also receives the validated `Idempotency-Key`. Most callers ignore it — the
 * receipt is the only thing that needs it — but an operation whose **domain** work is
 * resumable across requests needs a stable identity to resume under, and the key is the only
 * value the client is guaranteed to repeat. P3-09's behaviour migration derives its operation
 * id from it, which is what lets a replay recognise its own half-finished work instead of
 * starting a second migration.
 */
export async function idempotentJson(
  c: Context<AppEnv>,
  status: SuccessStatus,
  operation: (
    receiptFor: (data: unknown, cleanupRef?: CleanupRef) => IdempotencyReceipt,
    key: string,
  ) => Promise<unknown>,
  options: IdempotentJsonOptions = {},
): Promise<Response> {
  const key = c.get('idempotencyKey');
  const route = c.get('idempotencyRoute');
  const nowMs = c.get('idempotencyNowMs');
  const userId = c.get('userId');
  if (
    key === undefined ||
    route === undefined ||
    nowMs === undefined ||
    userId === undefined
  ) {
    throw new AppError('internal', 'An unexpected error occurred.');
  }

  let body: string | undefined;
  await operation((data, cleanupRef) => {
    body = JSON.stringify({ data, meta: { requestId: c.get('requestId') } });
    return {
      userId,
      key,
      route,
      status,
      body,
      ttl:
        Math.floor(nowMs / 1000) + (options.receiptTtlSeconds ?? IDEMPOTENCY_TTL_SECONDS),
      createdAt: new Date(nowMs).toISOString(),
      ...(cleanupRef === undefined ? {} : { cleanupRef }),
    };
  }, key);

  if (body === undefined) throw new AppError('internal', 'An unexpected error occurred.');
  return c.newResponse(body, status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
}
