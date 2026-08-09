import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { unregisterDevice } from '../services/deviceService.js';

/**
 * `DELETE /v1/me/devices/:deviceId` (`api-contract.md` §2.1).
 *
 * Called on sign-out **before** tokens are cleared, and on token rotation
 * (`auth.md` §3.4 step 2, P5-16 rules 2 and 3) — skipping it is how a resold or shared device
 * keeps receiving a stranger's reminders.
 *
 * `200` with the envelope rather than `204`. `api-contract.md` §1 says every endpoint returns
 * `{ data, meta }` and lists `200`/`201` as the success statuses; a `204` carries no body, so
 * it cannot carry one. `data` names the id that is now gone, which makes the response
 * self-describing in a log or a replayed request instead of an empty success that could have
 * been about anything.
 *
 * **This is the first `DELETE` in the codebase, so it sets the shape the rest inherit** —
 * P1-14's activity delete and every later one. Raised in the pull request rather than decided
 * quietly, because no canonical document states a status for a `DELETE`.
 *
 * The path parameter is not validated against the `dev_` ULID schema, deliberately: a
 * malformed id addresses no row and already answers `404`, and validating it first would turn
 * "no such device" into two different statuses for the same user-visible fact.
 *
 * The context carries its route pattern — `DELETE_DEVICE_PATH`, the same constant the route
 * mounts on — so `param` returns a `string` rather than `string | undefined`. Typing it
 * `Context<AppEnv>` and coping with the `undefined` would be writing a branch for a case
 * Hono cannot produce: this handler only runs on a path that matched.
 */
export const DELETE_DEVICE_PATH = '/devices/:deviceId';

export async function deleteDeviceHandler(
  c: Context<AppEnv, typeof DELETE_DEVICE_PATH>,
): Promise<Response> {
  const deviceId = c.req.param('deviceId');

  await unregisterDevice(requireUserId(c), deviceId, c.get('logger'));

  return c.json({
    data: { deviceId },
    meta: { requestId: c.get('requestId') },
  });
}
