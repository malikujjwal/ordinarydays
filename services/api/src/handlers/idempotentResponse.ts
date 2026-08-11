import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import {
  type CleanupRef,
  IDEMPOTENCY_TTL_SECONDS,
  type IdempotencyReceipt,
} from '../lib/idempotency.js';

type SuccessStatus = 200 | 201 | 202 | 204;

/** Precomputes the successful HTTP body before the domain transaction commits. */
export async function idempotentJson(
  c: Context<AppEnv>,
  status: SuccessStatus,
  operation: (
    receiptFor: (data: unknown, cleanupRef?: CleanupRef) => IdempotencyReceipt,
  ) => Promise<unknown>,
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
      ttl: Math.floor(nowMs / 1000) + IDEMPOTENCY_TTL_SECONDS,
      createdAt: new Date(nowMs).toISOString(),
      ...(cleanupRef === undefined ? {} : { cleanupRef }),
    };
  });

  if (body === undefined) throw new AppError('internal', 'An unexpected error occurred.');
  return c.newResponse(body, status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
}
