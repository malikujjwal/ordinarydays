import { zValidator } from '@hono/zod-validator';
import { patchUserInput } from '@od/shared/schemas';
import type { PatchUserInput } from '@od/shared/types';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { getMeHandler } from '../handlers/getMe.js';
import { patchMeHandler } from '../handlers/patchMe.js';

/**
 * `/v1/me` (`api-contract.md` §2.1).
 *
 * Two routes in this phase. `POST`/`DELETE /v1/me/devices` are P1-08, and `DELETE /v1/me`
 * and `GET /v1/me/export` are Phase 5 — absent rather than stubbed, so `routeSplit`'s
 * `not_implemented` answers for them, which is the honest response for a path that is in the
 * contract but not in this build.
 *
 * Both entries are registered in `ROUTE_REGISTRY`; app construction throws otherwise
 * (P1-30). Neither `creates`, so neither takes an `Idempotency-Key`: `PATCH` is idempotent
 * by nature and `GET` writes nothing.
 */

/**
 * `zValidator` with an explicit failure hook that **throws**.
 *
 * Its default is to return `c.json(result, 400)` itself — a body shaped like
 * `{ success: false, error: {...zod internals} }`, which is not the contract's envelope and
 * never reaches `errorHandler`. A client would get a 400 with no `error.code`, no
 * `error.message` and no `requestId`, from the one endpoint whose validation failures the
 * client is most likely to render. Throwing puts it back through the single place that
 * formats errors, which already maps a `ZodError` to `validation_failed` with a `details[]`
 * entry per issue.
 *
 * Found because a route test asserted `body.error.code` and got `undefined`.
 */
const validatePatch = zValidator('json', patchUserInput, (result) => {
  if (!result.success) throw result.error;
});

/**
 * The **strict** shared schema, so an unaccepted field is a `400` naming it rather than a
 * silent no-op — `email`, `cognitoSub` and `onboardingState` belong to the auth flow.
 */
export const me = new Hono<AppEnv>()
  .get('/', getMeHandler)
  .patch('/', validatePatch, (c) =>
    /**
     * `new Date()` at the edge. `coding-standards.md` §4.3 bans implicit-now inside pure
     * logic and anything that has to be testable; the route is the boundary, so this is
     * where the real clock is allowed to be read and handed down as a value.
     */
    patchMeHandler(c, present(c.req.valid('json')), new Date().toISOString()),
  );

/**
 * Drops keys whose value is `undefined`, so the result is a `PatchUserInput`.
 *
 * The validator's inferred output types every optional as `T | undefined`, which under
 * `exactOptionalPropertyTypes` is a different type from the domain interface's `T?` — and
 * meaningfully so. "Absent" and "explicitly undefined" are the same thing to a user and
 * different things to `Object.entries`, which the repository walks to build its update
 * expression. Normalising here means the repository can never be handed a key it would then
 * have to decide how to skip.
 *
 * `null` survives: it is *Off* for `defaultReminderOffset` and is written as a `REMOVE`.
 */
function present(patch: Record<string, unknown>): PatchUserInput {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as PatchUserInput;
}
