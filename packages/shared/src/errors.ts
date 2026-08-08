/**
 * The closed set of error codes the API may return.
 *
 * Canonical list: `docs/02-architecture/api-contract.md` §1, plus `not_implemented`
 * and `upgrade_required` from `docs/02-architecture/tech-stack.md` §4.4.
 *
 * The code → HTTP status table deliberately lives in `services/api/src/lib/errors.ts`,
 * not here: HTTP is a transport concern and `packages/shared` is imported by the client,
 * which has no business knowing that `conflict` means 409.
 */
export const ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'validation_failed',
  'conflict',
  'rate_limited',
  'series_limit_exceeded',
  'participant_limit_exceeded',
  'invite_expired',
  'invite_revoked',
  'not_implemented',
  'upgrade_required',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One field-level validation failure. Produced from `ZodError.issues`, path-mapped. */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * The error envelope. Every non-2xx response is exactly this shape.
 *
 * `message` is always safe to show a user: for `internal` it is the literal string
 * "An unexpected error occurred." and never the exception text (`tech-stack.md` §4.4).
 */
export interface AppErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId: string;
  };
}

/** Narrows an unknown response body to the error envelope. */
export function isAppErrorBody(value: unknown): value is AppErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value as { error: unknown };
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Record<string, unknown>;
  return (
    typeof candidate.code === 'string' &&
    (ERROR_CODES as readonly string[]).includes(candidate.code) &&
    typeof candidate.message === 'string' &&
    typeof candidate.requestId === 'string'
  );
}
