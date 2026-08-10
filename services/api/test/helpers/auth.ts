import { randomUUID } from 'node:crypto';

/**
 * The two things an integration test needs to make an authenticated request: the headers a
 * real client sends, and an app running as a chosen user (P1-28).
 *
 * **Neither sends an identity header, because there is none.** `createApp` takes an
 * `IdentityProvider` override for exactly this purpose (P1-01), so a test gets a second user
 * by constructing a second app rather than by a bypass header that would have to exist in the
 * production bundle. `withUser` is that constructor, named so the intent reads at the call
 * site.
 */

export interface AuthedHeaderOptions {
  /**
   * Sent only when supplied. A creating `POST` requires one (`api-contract.md` §1) and a
   * retry is a repeat of the same value, so the test decides: `crypto.randomUUID()` for "a
   * new request", a held constant for "the same request again". Everything else omits it, and
   * a route that does not create must not be sent one.
   */
  readonly idempotencyKey?: string;
  /**
   * `X-Client-Timezone`. Defaults to `America/New_York` rather than to UTC **on purpose**: UTC
   * is also the server's fallback, so a UTC default would let a handler that ignored the
   * header pass every test. A zone that is never the fallback makes "the caller's day" and
   * "the server's day" different days for five hours of every one.
   */
  readonly timezone?: string;
  /** `X-Client-Version`, in `api-contract.md` §1's `platform/version` shape. */
  readonly clientVersion?: string;
}

/**
 * The headers a client sends on every request: content type, a correlation id, the caller's
 * timezone, the client build, and an idempotency key when the route creates.
 *
 * `Content-Type` is unconditional. A `GET` carrying it is harmless — no handler parses a body
 * it was not given — and the alternative is an option that exists to remove a header nothing
 * reads.
 */
export function authedHeaders(options: AuthedHeaderOptions = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    /**
     * Echoed into every log line — and, on some routes, into `meta.requestId` in the response
     * body — so a failing test's output can be traced to one request.
     *
     * **The dashes are stripped**, which is the shape `resolveRequestId` mints for a request
     * that arrives without one. That is not cosmetic. A dashed UUID puts four `-<hex>`
     * boundaries into every response body, and `activities.int.test.ts` asserts that one
     * user's reminder offset — `-90` — appears **nowhere** in the serialised response of
     * another user's read (`security-privacy.md` §1 row 15). A random `...-90ab-...` satisfies
     * that substring by accident about once in sixty runs, which is a red build blamed on a
     * privacy leak that did not happen. An id drawn from an alphabet with no `-` cannot.
     */
    'X-Request-Id': `req_test_${randomUUID().replaceAll('-', '')}`,
    'X-Client-Timezone': options.timezone ?? 'America/New_York',
    'X-Client-Version': options.clientVersion ?? 'ios/1.0.0',
    ...(options.idempotencyKey === undefined
      ? {}
      : { 'Idempotency-Key': options.idempotencyKey }),
  };
}

/** What a test does with an app: send it a request. */
export interface TestApp {
  fetch(request: Request): Promise<Response>;
}

/**
 * An app that resolves every request as `userId` — or, with no argument, as whoever the
 * configured `AUTH_MODE` provider resolves, which in Phase 1 is `usr_local_dev`.
 *
 * ## Why the app is built inside `fetch`
 *
 * `src/app.ts` reaches `lib/config.ts`, which parses the environment **when it loads**, and
 * the table name in that environment is set by `test/integration/harness.ts` at its own module
 * scope. A static import here would make every file that imports this helper depend on
 * importing the harness first — an ordering rule that is invisible at the call site and that
 * fails as a query against the wrong table rather than as an error. Importing on first use
 * removes the rule entirely; Node caches the module, so it costs one dynamic import per file.
 *
 * A fresh app per request, which is what `createApp` exists to make cheap: no test can leave
 * state in another test's app.
 */
export function withUser(userId?: string): TestApp {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const { createApp } = await import('../../src/app.js');
      const app = createApp(
        userId === undefined
          ? {}
          : { identityProvider: { resolve: () => Promise.resolve(userId) } },
      );
      return app.fetch(request);
    },
  };
}
