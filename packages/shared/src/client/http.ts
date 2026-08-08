/**
 * The seam the typed API client is built on. P0-20 adds the implementation.
 *
 * What is here is only the shape of the injected dependencies, and it is here now rather
 * than later on purpose: the token provider is an interface parameter **from the first
 * commit** (phase-00 P0-07/P0-20), so the header-injection code path is written once and
 * never retrofitted. Phase 0 passes a provider that yields nothing, Phase 4 swaps in the
 * Cognito implementation, and no call site changes.
 *
 * Nothing in this package reads `process.env`. Configuration arrives as arguments from
 * `apps/mobile/src/lib/apiClient.ts`, which is where Expo's `extra` is read
 * (`tech-stack.md` §5.2).
 */

/** The global `fetch`, injected so tests can substitute a stub and RN can substitute its own. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/**
 * Supplies the bearer token, or nothing when signed out.
 *
 * Returning `undefined` must produce **no** `Authorization` header at all, not an empty
 * one — an empty bearer is a 401 that looks like a server fault.
 */
export interface AuthTokenProvider {
  getToken(): Promise<string | undefined>;
}

/** A provider for the signed-out case and for Phase 0, where there is no auth yet. */
export const nullTokenProvider: AuthTokenProvider = {
  getToken: () => Promise.resolve(undefined),
};

export interface HttpClientConfig {
  baseUrl: string;
  fetch: FetchLike;
  tokenProvider: AuthTokenProvider;
  /** IANA zone sent as `X-Client-Timezone` on every request. */
  timezone: string;
  /** `ios/1.4.0` or `web/1.4.0`, sent as `X-Client-Version`. */
  clientVersion: string;
}
