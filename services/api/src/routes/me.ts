import { zValidator } from '@hono/zod-validator';
import { patchUserInput, registerDeviceInput } from '@od/shared/schemas';
import type { PatchUserInput, RegisterDeviceInput } from '@od/shared/types';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { DELETE_DEVICE_PATH, deleteDeviceHandler } from '../handlers/deleteDevice.js';
import { getMeHandler } from '../handlers/getMe.js';
import { patchMeHandler } from '../handlers/patchMe.js';
import { postDeviceHandler } from '../handlers/postDevice.js';

/**
 * `/v1/me` (`api-contract.md` §2.1).
 *
 * Four routes in this phase: the profile pair (P1-07) and the device pair (P1-08).
 * `DELETE /v1/me` and `GET /v1/me/export` are Phase 5 — absent rather than stubbed, so
 * `routeSplit`'s `not_implemented` answers for them, which is the honest response for a path
 * that is in the contract but not in this build.
 *
 * **The devices live here rather than in a `devices.ts` of their own**, because
 * `api-contract.md` §1 asks for one route file per resource and §2.1 puts them under Me: they
 * are a property of the signed-in user, they hang off `/v1/me`, and there is no `/v1/devices`
 * to be a resource at. `app.route('/v1/me', me)` is unchanged.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise (P1-30).
 * Only the `POST` `creates`, so only it takes an `Idempotency-Key`: `PATCH` is idempotent by
 * nature, `GET` writes nothing, and a `DELETE` of a specific id is idempotent in the sense
 * the header exists to protect — a retry cannot produce a second deletion.
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

/** Same hook, same reason — see {@link validatePatch}. */
const validateDevice = zValidator('json', registerDeviceInput, (result) => {
  if (!result.success) throw result.error;
});

/**
 * The **strict** shared schemas, so an unaccepted field is a `400` naming it rather than a
 * silent no-op — `email`, `cognitoSub` and `onboardingState` belong to the auth flow, and a
 * `deviceId` in a registration body is a client asking for an upsert this endpoint does not
 * offer.
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
  )
  .post('/devices', validateDevice, (c) =>
    postDeviceHandler(c, device(c.req.valid('json')), new Date().toISOString()),
  )
  .delete(DELETE_DEVICE_PATH, deleteDeviceHandler);

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

/**
 * The same `exactOptionalPropertyTypes` normalisation for the registration body, written out
 * rather than routed through {@link present}: this one has exactly one optional field, and a
 * shared generic helper over two unrelated shapes would need a cast at every call site to say
 * which shape came back. `deviceName` absent and `deviceName: undefined` are the same thing
 * to a caller and different things to `Object.entries`, which the repository walks.
 *
 * Unlike a patch, no value here is meaningfully `null` — there is nothing to clear, because a
 * device row is created and deleted rather than edited.
 */
function device(input: {
  expoPushToken: string;
  platform: 'ios';
  deviceName?: string | undefined;
}): RegisterDeviceInput {
  return {
    expoPushToken: input.expoPushToken,
    platform: input.platform,
    ...(input.deviceName === undefined ? {} : { deviceName: input.deviceName }),
  };
}
