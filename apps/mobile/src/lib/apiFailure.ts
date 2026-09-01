import { ApiError } from '@od/shared/client';

/**
 * The §5.3 failure copy, in one place (`interaction-contract.md` §5.3).
 *
 * A 5xx never surfaces the exception's own text — `Failed to fetch` describes a socket — and
 * a 4xx that came back through the envelope *is* the server's user-facing sentence. Every
 * hook that renders a failure banner formats through here so the copy has one owner;
 * `fallback` is the caller's verb (`"Couldn't save this."`, `"Couldn't load this."`).
 */
export function describeApiFailure(
  error: unknown,
  fallback: string,
): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    const requestId = error.requestId === undefined ? {} : { requestId: error.requestId };
    if (error.status >= 500) {
      return { message: 'Something went wrong.', ...requestId };
    }
    return { message: error.message, ...requestId };
  }
  return { message: fallback };
}
