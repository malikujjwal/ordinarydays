import { ApiError } from '@od/shared/client';

/** The server envelope's failure shape, as one named predicate rather than inline casts. */
interface EnvelopeFailure {
  readonly status: number;
  readonly message: string;
  readonly requestId?: string;
}

/**
 * True only for a rejection with envelope **provenance**: the real `ApiError` class, or an
 * envelope-shaped object that also carries the server's `requestId` (a rehydrated queued
 * error, a second bundled copy of the client). A random exception that merely happens to
 * hold a numeric `status` and a string `message` does not qualify — §2.3 forbids exception
 * text becoming user copy, and the `requestId` is the marker only the envelope supplies.
 */
function isEnvelopeFailure(error: unknown): error is EnvelopeFailure {
  if (error instanceof ApiError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as Partial<Record<'status' | 'message' | 'requestId', unknown>>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.message === 'string' &&
    typeof candidate.requestId === 'string'
  );
}

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
  if (!isEnvelopeFailure(error)) return { message: fallback };
  const requestId =
    typeof error.requestId === 'string' ? { requestId: error.requestId } : {};
  if (error.status >= 500) {
    return { message: 'Something went wrong.', ...requestId };
  }
  return { message: error.message, ...requestId };
}
