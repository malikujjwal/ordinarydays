import type { AppErrorBody, ErrorCode, ErrorDetail } from '@od/shared/errors';
import { RecurrenceValidationError } from '@od/shared/recurrence';
import type { Context } from 'hono';
import { ZodError } from 'zod';
import type { AppEnv } from '../app-env.js';
import { AppError, INTERNAL_ERROR_MESSAGE, statusFor } from '../lib/errors.js';

/**
 * Chain entry 3, registered as `app.onError` so it catches throws from every later
 * middleware as well as from handlers.
 *
 * Everything leaves through here in the contract's envelope (`api-contract.md` §1). Nothing
 * else in the service formats an error response.
 */

/** DynamoDB exception names that mean something specific to a caller. */
const DDB_ERROR_MAP: Record<string, ErrorCode> = {
  ConditionalCheckFailedException: 'conflict',
  TransactionCanceledException: 'conflict',
};

const THROUGHPUT_ERRORS = new Set([
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);

function zodDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function classify(err: Error): {
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
  retryAfterSeconds?: number;
  status?: 503;
} {
  if (err instanceof AppError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined && { details: err.details }),
      ...(err.retryAfterSeconds !== undefined && {
        retryAfterSeconds: err.retryAfterSeconds,
      }),
    };
  }

  if (err instanceof ZodError) {
    return {
      code: 'validation_failed',
      message: 'The request was not valid.',
      details: zodDetails(err),
    };
  }

  if (err instanceof RecurrenceValidationError) {
    return { code: err.code, message: err.message };
  }

  if (THROUGHPUT_ERRORS.has(err.name)) {
    return {
      code: 'internal',
      message: INTERNAL_ERROR_MESSAGE,
      retryAfterSeconds: 1,
      status: 503,
    };
  }

  const mapped = DDB_ERROR_MAP[err.name];
  if (mapped !== undefined) {
    return { code: mapped, message: 'The request could not be completed.' };
  }

  // Anything uncaught. The message is the literal string, never `err.message`, which can
  // carry a table name, a key fragment or user content.
  return { code: 'internal', message: INTERNAL_ERROR_MESSAGE };
}

export function errorHandler(err: Error, c: Context<AppEnv>): Response {
  const {
    code,
    message,
    details,
    retryAfterSeconds,
    status: statusOverride,
  } = classify(err);
  const status = statusOverride ?? statusFor(code);
  const requestId = c.get('requestId') ?? 'req_unknown';

  // Every 5xx logs with the stack; every 4xx logs without one (`tech-stack.md` §4.4).
  const log = c.get('logger');
  if (log !== undefined) {
    if (status >= 500) log.error({ err, code }, 'unhandled error');
    else log.warn({ code, status }, 'request error');
  }

  const body: AppErrorBody = {
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
      requestId,
    },
  };

  if (retryAfterSeconds !== undefined) {
    c.header('Retry-After', String(retryAfterSeconds));
  }
  if (code === 'unauthenticated') {
    c.header('WWW-Authenticate', 'Bearer');
  }

  return c.json(body, status);
}
