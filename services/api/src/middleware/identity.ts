// `UserId` is inferred from the `userId` schema and lives in `@od/shared/schemas`, not in
// `@od/shared/types` as P1-01's sketch has it — the entity interfaces import it from there
// too (`types/activity.ts`).
import type { UserId } from '@od/shared/schemas';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { type Config, config } from '../lib/config.js';
import { AppError } from '../lib/errors.js';

/**
 * Chain entry 8. The one place in the codebase that knows where a user id comes from
 * (`tech-stack.md` §4.2 row 8, `phase-01-activity-core.md` P1-01).
 *
 * This task is the reason Phases 1 to 3 can be built with no authentication without any of
 * that work needing to be revisited. Every handler, service and repository reads
 * `c.get('userId')` and knows nothing about where it came from; Phase 4 replaces one
 * implementation of one interface and no call site changes.
 *
 * ## `AUTH_MODE` may appear in exactly two files
 *
 * `lib/config.ts` and this one. That is not a style preference — it is what keeps the Phase 4
 * change small. Without it `AUTH_MODE` leaks into a handler within a fortnight and Phase 4
 * becomes a search-and-replace across the API. Enforced by
 * `node scripts/check-forbidden.mjs auth-mode-containment`, which runs in CI as its own step.
 */

/**
 * Resolve a request to the user it acts for.
 *
 * **One method, returning one string.** Not a session, not a token, not a claim set, not a
 * permission list — everything the rest of the system needs from identity is the id, and
 * keeping the return type this narrow is what keeps the seam honest. A richer return type
 * would be consumed somewhere, and then Phase 4 would owe that consumer a Cognito-shaped
 * equivalent.
 */
export interface IdentityProvider {
  /** Throws `AppError('unauthenticated')` when it cannot. */
  resolve(c: Context): Promise<UserId>;
}

/**
 * The id every request runs as in Phases 1 to 3.
 *
 * **Deliberately not a ULID.** It is instantly recognisable in a table browser, greps
 * cleanly, and can never collide with a real generated id. The consequence is that the shared
 * `userId` schema is a prefixed-string check rather than `ulidId('usr')`, with the strict
 * assertion kept at the point of *generation* in P1-07 — a validator that rejects the id the
 * system is currently running as is a validator that gets deleted under pressure.
 */
export const LOCAL_USER_ID = 'usr_local_dev' as UserId;

/**
 * Phase 1's provider. Returns a constant.
 *
 * **It reads nothing.** No header, no token, no cookie, no query parameter, no network call.
 * That is the whole security property: there is no input a caller can supply that changes who
 * they are, so there is nothing to guard and nothing to get wrong. It also has no failure
 * mode, which is why `resolve` here can never throw.
 *
 * `async` despite needing no await, because `CognitoIdentityProvider` must await verification
 * and a synchronous interface would force Phase 4 to change the signature — and therefore
 * every call site, which is precisely what this seam exists to prevent.
 */
export class LocalIdentityProvider implements IdentityProvider {
  resolve(_c: Context): Promise<UserId> {
    return Promise.resolve(LOCAL_USER_ID);
  }
}

/**
 * Selection by mode.
 *
 * `cognito` is **absent, not stubbed**. An empty `CognitoIdentityProvider` that throws is a
 * file somebody half-fills; the interface above is the contract, not a placeholder class. The
 * record is typed so that Phase 4 adding the key is a one-line change here and a compile
 * error if it forgets — `Record<Config['AUTH_MODE'], …>` requires every mode to be present,
 * so this file cannot type-check today unless the missing mode is spelled out as missing.
 */
const providers: Record<Config['AUTH_MODE'], () => IdentityProvider> = {
  local: () => new LocalIdentityProvider(),
  /**
   * Phase 4 replaces this with the verifier in `auth.md` §5.1: a module-scope
   * `CognitoJwtVerifier` hydrated during init, returning the `custom:app_user_id` claim.
   * Until then, reaching it is a configuration error and must fail loudly at startup rather
   * than answer requests as somebody.
   */
  cognito: () => {
    throw new Error(
      'AUTH_MODE=cognito is not implemented until Phase 4 (P4-05). Refusing to start.',
    );
  },
};

/**
 * Resolved **once per execution environment**, at module scope, never per request.
 *
 * In Phase 4 that is what keeps the JWKS fetch out of the request path. In Phase 1 it costs
 * nothing and establishes the shape — which is the point of doing it now rather than when it
 * starts to matter.
 */
export const identityProvider: IdentityProvider = providers[config.AUTH_MODE]();

/**
 * Builds the middleware over a given provider.
 *
 * Parameterised so `createApp` can inject a stub and a route test can run as a second user
 * (P0-13's `overrides`). The alternative — an `X-Dev-User` header — is shipped code that
 * reads attacker-controlled input to decide who you are, guarded only by an environment
 * check. Injection gives tests the same capability with nothing in the production bundle to
 * guard.
 */
export function createIdentity(provider: IdentityProvider = identityProvider) {
  return createMiddleware<AppEnv>(async (c, next) => {
    /**
     * **It asks step 7; it never re-derives the boundary from the path.**
     *
     * `routeSplit` is the single place public/private is decided, and a second path check
     * here would be a second opinion on a security boundary — the two would eventually
     * disagree about a trailing slash, silently, on the one question where being wrong is
     * unbounded. `public` and `unauthenticated-private` routes get no user id at all, so a
     * handler on one cannot read an identity it was never meant to have.
     */
    if (c.get('routeAuth') !== 'authenticated') {
      await next();
      return;
    }

    c.set('userId', await provider.resolve(c));
    await next();
  });
}

/** The instance the app mounts. */
export const identity = createIdentity();

/**
 * The user id for a request, for handlers and services.
 *
 * Throws rather than returning `undefined`, because reaching this on a route that resolved no
 * identity is a routing bug — an `authenticated` entry missing from `ROUTE_REGISTRY` — and
 * the honest answer to a bug is a `500`, not a query keyed on the string `"undefined"`.
 * `AppEnv` types `userId` as optional precisely so that reading it directly is a type error
 * and this is the only way through.
 */
export function requireUserId(c: Context<AppEnv>): UserId {
  const userId = c.get('userId');
  if (userId === undefined) {
    throw new AppError(
      'internal',
      'This route resolved no identity. Its ROUTE_REGISTRY entry is missing or wrong.',
    );
  }
  return userId;
}
