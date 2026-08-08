import { ApiError, getHealth } from '@od/shared/client';
// The type comes from `@od/shared/schemas`, where the shape is defined once. `client`
// exports the function that returns it, not a second copy of what it is.
import type { HealthData } from '@od/shared/schemas';
import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl, apiClient } from '@/lib/apiClient';

/**
 * The health check, and the first feature hook in the app.
 *
 * It establishes the layering rule the whole client follows (`tech-stack.md` §3.2): **this
 * is the only kind of place `useQuery` appears.** A screen calls a hook, a hook calls the
 * shared client, and the shared client is the only thing that knows the wire is HTTP. A
 * `fetch` in a component is a review rejection, and it is worth enforcing on the first
 * screen rather than the tenth — by then the pattern is whatever the tenth screen did.
 */

/** The query key. Namespaced from the start so P1's keys can sit beside it, not under it. */
export const healthKey = ['health'] as const;

export interface HealthView {
  /** `pending` before the first answer, then `success` or `error`. */
  status: 'pending' | 'success' | 'error';
  data?: HealthData;
  /** Wall-clock time for the whole call, retries included. */
  roundTripMs?: number;
  /** The API this build is talking to. Known before any request, and shown even on failure. */
  baseUrl: string;
  /** Present when the failure came back through the envelope, so it can be quoted to support. */
  requestId?: string;
  message?: string;
  isRefetching: boolean;
  refetch: () => void;
}

/**
 * What went wrong, in the words `interaction-contract.md` §5.3 uses.
 *
 * Deliberately not the exception's own message: `Failed to fetch` and
 * `ERR_CONNECTION_REFUSED` describe a socket, not a situation, and this screen exists to be
 * read on a phone by someone deciding whether the laptop is reachable.
 */
function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return error.status >= 500
      ? { message: 'Something went wrong.', requestId: error.requestId }
      : { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't load this." };
}

export function useHealth(): HealthView {
  const query = useQuery({
    queryKey: healthKey,
    queryFn: async ({ signal }) => {
      // Measured around the whole call, so it includes the client's own retries. A number
      // that excluded them would read as "fast" on exactly the request that was not.
      const startedAt = Date.now();
      const data = await getHealth(apiClient, signal);
      return { data, roundTripMs: Date.now() - startedAt };
    },
    /**
     * A diagnostic must never answer from cache: the whole question it exists to settle is
     * "can this device reach the API **now**". `staleTime: 0` overrides the 60-second
     * default that is right for the agenda and wrong here.
     */
    staleTime: 0,
    /**
     * `always`, overriding the app-wide `offlineFirst` (`tech-stack.md` §3.4).
     *
     * Under `offlineFirst` a network-class failure **pauses** the query instead of failing
     * it, and it resumes only when `onlineManager` reports the browser back online. Every
     * failure this screen is built to diagnose — API not running, wrong port, wrong LAN
     * address, firewall, CORS — happens while the device is perfectly online, so that event
     * never comes. The query sits paused for ever, and `refetch()` is paused with it, which
     * makes the `Try again` button do nothing. Verified on the web target in P0-22 before
     * this line existed.
     */
    networkMode: 'always',
    /**
     * No retries at this layer. `createHttpClient` already retries a network failure or a
     * 5xx three times with jittered backoff, and stacking Query's three rounds on top is
     * the multiplication flagged in P0-20 — up to sixteen requests, and here it would also
     * mean waiting the better part of a minute to be told the API is not running. The
     * transport owns retries; this layer reports what it concluded.
     */
    retry: false,
  });

  /**
   * A query can fail without reaching `error`, and this screen must not hide that.
   *
   * With `networkMode: 'offlineFirst'` (`tech-stack.md` §3.4) the first attempt always goes
   * out, but if it fails as a *network* error TanStack Query **pauses** rather than
   * retrying: `status` stays `pending` and `fetchStatus` becomes `paused`. A screen that
   * reads only `status` therefore shows its loading state forever, with the failure sitting
   * in `failureReason` where nobody looks.
   *
   * That is exactly the "the device shows a spinner forever" this screen exists to abolish,
   * so a paused query with a failure behind it is reported as the failure it is.
   */
  const isPausedAfterFailure = query.fetchStatus === 'paused' && query.failureCount > 0;

  const failure =
    query.error !== null
      ? describe(query.error)
      : isPausedAfterFailure
        ? describe(query.failureReason)
        : undefined;

  return {
    status: isPausedAfterFailure ? 'error' : query.status,
    baseUrl: apiBaseUrl,
    isRefetching: query.isRefetching,
    refetch: () => void query.refetch(),
    ...(query.data === undefined
      ? {}
      : { data: query.data.data, roundTripMs: query.data.roundTripMs }),
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
  };
}
