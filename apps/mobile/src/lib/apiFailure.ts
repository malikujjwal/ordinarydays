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
  /**
   * Structural, not `instanceof ApiError`: an envelope-shaped rejection can lose its class
   * identity (a rehydrated queued error, a second bundled copy of the client, a test
   * double), and the server's 4xx sentence must still surface. `ApiError` instances pass
   * this shape check, so the class needs no special case.
   */
  if (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { status?: unknown }).status === 'number' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const api = error as { status: number; message: string; requestId?: unknown };
    const requestId =
      typeof api.requestId === 'string' ? { requestId: api.requestId } : {};
    if (api.status >= 500) {
      return { message: 'Something went wrong.', ...requestId };
    }
    return { message: api.message, ...requestId };
  }
  return { message: fallback };
}
