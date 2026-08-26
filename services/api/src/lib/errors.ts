import type { ErrorCode, ErrorDetail } from '@od/shared/errors';
import type { ListBehaviourConfirmation } from '@od/shared/types';

/**
 * One error class, one table, one place (`tech-stack.md` §4.4).
 *
 * The `ErrorCode` union itself lives in `@od/shared`, because the client needs it too. The
 * **HTTP mapping** lives here and only here: HTTP is a transport concern, and the client
 * has no business knowing that `conflict` means 409.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
    readonly retryAfterSeconds?: number,
    readonly confirmation?: ListBehaviourConfirmation,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * `series_limit_exceeded` is deliberately absent. It is not an error — it is returned as a
 * `warnings[]` entry on a successful response (`tech-stack.md` §4.4), so it must never
 * reach this table. A lookup for it is a bug at the call site.
 */
export const ERROR_STATUS = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  payload_too_large: 413,
  conflict: 409,
  participant_limit_exceeded: 422,
  reminder_limit_exceeded: 422,
  invite_expired: 410,
  invite_revoked: 410,
  rate_limited: 429,
  not_implemented: 501,
  upgrade_required: 426,
  internal: 500,
} as const satisfies Record<Exclude<ErrorCode, 'series_limit_exceeded'>, number>;

/**
 * The literal string a 500 always returns. Never the exception text: an exception message
 * can carry a table name, a key fragment, or user content
 * (`security-privacy.md` §4.2).
 */
export const INTERNAL_ERROR_MESSAGE = 'An unexpected error occurred.';

export function statusFor(code: ErrorCode) {
  if (code === 'series_limit_exceeded') return 200;
  return ERROR_STATUS[code];
}
