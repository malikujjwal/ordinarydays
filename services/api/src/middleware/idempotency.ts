import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { complete, release, reserve } from '../repositories/idempotencyRepository.js';
import { ROUTE_REGISTRY, type RouteEntry } from './routeRegistry.js';

/**
 * Chain entry 10 (`tech-stack.md` §4.2, `api-contract.md` §1, P1-04).
 *
 * A creating `POST` carries an `Idempotency-Key`; a repeat with the same key returns the
 * stored response instead of creating a second thing. Required because mobile networks
 * retry — a request that timed out on the phone may well have succeeded on the server.
 *
 * It runs **after** `rateLimit`, so a retry storm cannot write idempotency records for free.
 *
 * ## The key is user-scoped, and that is a security requirement
 *
 * The partition is IDEM, then the caller's user id, then the key. Dropping the user id —
 * partitioning on the key alone — would let one user's client-generated key return another
 * user's stored response. `data-model.md` §3.4 records the scoped form and calls the bare one
 * a defect rather than a shorthand. It is tempting to write the bare form while
 * `usr_local_dev` is the only user; the scoping is pinned by a test for that reason.
 *
 * (Written out in words rather than as the literal pattern because
 * `check-forbidden.mjs no-key-literals` matches quoted key prefixes anywhere outside the
 * repository layer, comments included — and unlike the `AUTH_MODE` rule, this one loses
 * nothing by being described instead of quoted. The builder is `keys.idempotency`.)
 *
 * **Nothing about this key changes in Phase 4.** The partition is already user-scoped; a real
 * Cognito subject simply produces a different value in the same position. No migration, no
 * dual-read, no compatibility shim.
 *
 * ## Which routes need a key
 *
 * The route says so, via `creates` on its `ROUTE_REGISTRY` entry. The verb cannot answer it:
 * `POST /v1/activities/:id/complete` is naturally idempotent and takes no key, `/duplicate`
 * creates and takes one. Deriving it from `POST` alone would `400` every completion.
 */

/**
 * A UUID, in any version. `api-contract.md` §1 says "UUID from the client", and the client
 * generates one with `expo-crypto`'s `randomUUID` (`tech-stack.md` §2.2).
 *
 * Validated rather than accepted as any string, because the key is a partition-key fragment:
 * an unbounded client-supplied value is an unbounded key, and a shape check is the cheapest
 * place to stop that. It is deliberately not a strict v4 check — pinning the version would
 * reject a perfectly good v7 the day a client library changes its default.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MIDDLEWARE_METHOD = 'ALL';

/** The route Hono resolved, matched against the registry — the same shape `routeSplit` uses. */
function entryFor(
  registry: readonly RouteEntry[],
  matched: readonly { method: string; path: string }[] | undefined,
): RouteEntry | undefined {
  const route = matched?.find((candidate) => candidate.method !== MIDDLEWARE_METHOD);
  if (route === undefined) return undefined;
  return registry.find(
    (entry) => entry.method === route.method && entry.pattern === route.path,
  );
}

export interface IdempotencyOptions {
  readonly registry?: readonly RouteEntry[];
  /** Injected so the stored `ttl` is assertable without freezing the clock globally. */
  readonly now?: () => number;
}

export function createIdempotency(options: IdempotencyOptions = {}) {
  const registry = options.registry ?? ROUTE_REGISTRY;
  const now = options.now ?? (() => Date.now());

  return createMiddleware<AppEnv>(async (c, next) => {
    if (c.req.method !== 'POST') {
      await next();
      return;
    }

    const entry = entryFor(registry, c.req.matchedRoutes);
    if (entry?.creates !== true) {
      await next();
      return;
    }

    const key = c.req.header('Idempotency-Key');
    if (key === undefined || !UUID.test(key)) {
      throw new AppError(
        'validation_failed',
        'This request needs an Idempotency-Key header containing a UUID.',
        [{ path: 'Idempotency-Key', message: 'Required, and must be a UUID.' }],
      );
    }

    /**
     * An `authenticated` route always has a user by here — `identity` at position 8 set it.
     * If it does not, the route's registry entry is wrong, and keying the record under a
     * shared fallback would let one caller replay another's response. Let it through;
     * `requireUserId` in the handler raises the real fault.
     */
    const userId = c.get('userId');
    if (userId === undefined) {
      await next();
      return;
    }

    const route = `${c.req.method} ${entry.pattern}`;
    const reservation = await reserve(userId, key, route, now());

    if (reservation.kind === 'replay') {
      /**
       * **`200`, not the stored status.** `api-contract.md` §1: "A repeat with the same key
       * returns the stored response with `200` instead of creating a duplicate", and P1-11's
       * own tests say the same. P1-04's prose says "the stored status … unchanged", which
       * would answer `201` here — the outlier phrase, and flagged in the PR rather than
       * quietly followed.
       *
       * The body is byte-identical, which means it carries the **original** request's
       * `meta.requestId`. That is the intended reading of "identical body", and it is useful:
       * it points at the request that actually created the thing.
       */
      return c.newResponse(reservation.record.body ?? '', 200, {
        'Content-Type': 'application/json; charset=utf-8',
      });
    }

    if (reservation.kind === 'in-flight') {
      throw new AppError(
        'conflict',
        'A request with this Idempotency-Key is already in progress.',
      );
    }

    try {
      await next();
    } catch (error) {
      // The handler threw. Free the key so the client's retry is not answered `409` for the
      // next 24 hours, then let `errorHandler` format the failure as it normally would.
      await release(userId, key).catch(() => {});
      throw error;
    }

    const status = c.res.status;
    if (status < 200 || status >= 300) {
      // A handler that returned a 4xx without throwing. Same reasoning as the catch above:
      // only successful responses are stored, so a 500 is never replayed for 24 hours.
      await release(userId, key).catch(() => {});
      return;
    }

    // `clone()` because reading a response body consumes it, and this one still has to be
    // sent. Without the clone the caller receives an empty body.
    const body = await c.res.clone().text();
    await complete(userId, key, status, body);
  });
}

/** The instance the app mounts. */
export const idempotency = createIdempotency();
