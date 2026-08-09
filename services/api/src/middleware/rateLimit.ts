import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import {
  consume,
  type RateLimitRule,
  type RateLimitScope,
} from '../repositories/rateLimitRepository.js';

/**
 * Chain entry 9 (`tech-stack.md` §4.2, `api-contract.md` §4, P1-03).
 *
 * A fixed-window counter in DynamoDB, keyed by the user for authenticated routes. Over the
 * limit is `429 rate_limited` with `Retry-After`.
 *
 * It runs **after** `identity`, because an authenticated route's counter is keyed on
 * `c.get('userId')`, and **before** `idempotency` (P1-04), so a retry storm cannot write
 * idempotency records for free.
 *
 * ## What it does not limit
 *
 * `unauthenticated-private` — which is `/v1/health` and nothing else — is deliberately
 * absent from `api-contract.md` §4's table, and so from {@link RULES}. Health is what every
 * smoke test and every CloudWatch alarm calls, and a limiter that can silence the liveness
 * signal turns a traffic spike into a false outage. It also performs no I/O, so there is
 * nothing to protect.
 *
 * The middleware reads the user id from the context and does not care that every request in
 * Phase 1 carries the same one. Locally that means one shared counter, which is correct
 * behaviour and useful to have exercised before real users exist.
 */

/**
 * The general authenticated allowance. `api-contract.md` §4 row 1.
 *
 * A minute window rather than an hour: the point is to stop a runaway client, and an hourly
 * bucket would let one burst through 120 requests in a second and then answer normally for
 * fifty-nine minutes.
 */
const GENERAL: RateLimitRule = { scope: 'general', limit: 120, windowSeconds: 60 };

/**
 * The two narrower windows, matched on method and path prefix. `api-contract.md` §4 rows 2
 * and 3.
 *
 * Neither route is mounted yet — capture is P1-18 and `upload-url` is Phase 3 — but the rule
 * is written now because its *absence* is what would go unnoticed: a capture endpoint that
 * shipped inheriting the general 120/min would be 120 model calls a minute against the spend
 * this row exists to protect, and nothing about that failure looks wrong in a log.
 *
 * Order matters: the first match wins, so more specific prefixes come first.
 */
const OVERRIDES: ReadonlyArray<{
  readonly method: string;
  readonly prefix: string;
  readonly rule: RateLimitRule;
}> = [
  {
    method: 'POST',
    prefix: '/v1/capture/',
    // Protects the model spend, which is why it is per hour and an order of magnitude
    // tighter than everything else.
    rule: { scope: 'capture', limit: 20, windowSeconds: 3600 },
  },
  {
    method: 'POST',
    prefix: '/v1/attachments/upload-url',
    rule: { scope: 'upload-url', limit: 60, windowSeconds: 3600 },
  },
];

/**
 * The rule for a request, or `undefined` when this route is not limited at all.
 *
 * ## `public` returns `undefined`, and that is a deferral rather than an omission
 *
 * `api-contract.md` §4 row 4 limits `/public/v1/*` to 30 req/min **per IP**, whose subject
 * would be `sha256(clientIp + salt)` (`security-privacy.md` §5). It is not built here, and
 * the reason is the salt rather than the counter: an *unsalted* digest of an IPv4 address is
 * reversible — 2^32 is minutes of compute — so shipping one would write a re-identifiable
 * address into the table while §3's classification row claims addresses are only ever stored
 * hashed. A salt is a secret, §6.2 keeps secrets out of environment variables, and SSM
 * Parameter Store arrives in Phase 4. No task defines the salt today.
 *
 * Nothing is unprotected in the meantime: `ROUTE_REGISTRY` mounts no `/public/v1/*` route,
 * and the first arrives in Phase 6 with invites. `hashSubject` in the repository already
 * takes the salt as a required parameter, so wiring this up is a rule added here plus a
 * value supplied there — no shape in either file changes.
 */
export function ruleFor(
  routeAuth: AppEnv['Variables']['routeAuth'],
  method: string,
  path: string,
): RateLimitRule | undefined {
  if (routeAuth !== 'authenticated') return undefined;

  const override = OVERRIDES.find(
    (candidate) => candidate.method === method && path.startsWith(candidate.prefix),
  );
  return override?.rule ?? GENERAL;
}

/** Exported for the test that asserts the scopes are distinct, so counters cannot collide. */
export const SCOPES: readonly RateLimitScope[] = [
  GENERAL.scope,
  ...OVERRIDES.map((o) => o.rule.scope),
];

export interface RateLimitOptions {
  /** Injected so the window boundary is testable without waiting a real minute. */
  readonly now?: () => number;
}

export function createRateLimit(options: RateLimitOptions = {}) {
  const now = options.now ?? (() => Date.now());

  return createMiddleware<AppEnv>(async (c, next) => {
    const rule = ruleFor(c.get('routeAuth'), c.req.method, c.req.path);
    if (rule === undefined) {
      await next();
      return;
    }

    /**
     * An `authenticated` route always has a user by the time this runs — `identity` at
     * position 8 set it. If it did not, the route's `ROUTE_REGISTRY` entry is wrong, and
     * limiting it under a shared fallback subject would hide that behind a counter every
     * caller shares. Let it through; `requireUserId` in the handler raises the real fault.
     */
    const userId = c.get('userId');
    if (userId === undefined) {
      await next();
      return;
    }

    const outcome = await consume(rule, userId, now());

    if (outcome.degraded) {
      // Log and allow. A limiter that takes the API down is worse than one that
      // occasionally lets a request through (P1-03).
      c.get('logger')?.warn(
        { scope: rule.scope },
        'rate limit counter unavailable; allowing the request',
      );
    }

    if (!outcome.allowed) {
      /**
       * Thrown rather than returned so it leaves through `errorHandler` like every other
       * error, in the one envelope. `retryAfterSeconds` becomes the `Retry-After` header
       * there — and throwing the `AppError` directly is what keeps the raw
       * `ConditionalCheckFailedException` from reaching that handler's DynamoDB map, which
       * would classify it as `conflict` and answer 409.
       */
      throw new AppError(
        'rate_limited',
        'Too many requests.',
        undefined,
        outcome.retryAfterSeconds,
      );
    }

    await next();
  });
}

/** The instance the app mounts. */
export const rateLimit = createRateLimit();
