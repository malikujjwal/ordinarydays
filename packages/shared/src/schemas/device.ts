import { z } from 'zod';
import { MAX_FREE_TEXT_LEN } from '../constants.js';
import { ulidId } from './common.js';

/**
 * A registered push device, as a schema (`data-model.md` §4.0a, `api-contract.md` §2.1).
 *
 * The interface lives in `../types/device.ts`; this file is the runtime check. Neither
 * restates the other, and `device.test.ts` asserts in both directions that they describe the
 * same shape — the pattern `schemas/user.ts` established.
 */

export const deviceId = ulidId('dev');

/**
 * One member. iOS is the only platform that registers in v1 — see the note on
 * `DevicePlatform` in `../types/device.ts` for why a union of one is the honest shape and
 * what Android costs when it arrives.
 */
export const devicePlatform = z.enum(['ios']);

/**
 * An Expo push token: `ExponentPushToken[…]`.
 *
 * The shape P5-16 names, "validated by a Zod schema in `packages/shared`, defined once and
 * imported by both sides" — so this is that schema and there is no second copy on the client.
 *
 * **Both spellings are accepted.** `expo-notifications` has issued the token under
 * `ExpoPushToken[…]` as well as `ExponentPushToken[…]`, and `expo-server-sdk`'s own
 * `isExpoPushToken` accepts either; a validator that took only the longer spelling would
 * reject a perfectly deliverable token, and it would be discovered on a physical device in
 * Phase 5 rather than here. The bracketed form itself is the part worth pinning: it is what
 * separates an Expo token from a raw APNs one, which this API never sees.
 *
 * Bounded on both ends, like every other string that becomes a stored attribute.
 */
export const expoPushToken = z
  .string()
  .max(200)
  .regex(
    /^Exp(?:o|onent)PushToken\[[A-Za-z0-9_-]{1,128}\]$/,
    'Expected an Expo push token, e.g. ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  );

/**
 * A label for the install. Free text, so it takes the free-text bound rather than a number
 * of its own — {@link MAX_FREE_TEXT_LEN} is the same limit `service`, `placeName` and
 * `organiser` use (`activities.md` §3 rule 6).
 */
export const deviceName = z.string().min(1).max(MAX_FREE_TEXT_LEN);

export const device = z
  .object({
    deviceId,
    expoPushToken,
    platform: devicePlatform,
    deviceName: deviceName.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    schemaVersion: z.literal(1),
  })
  .meta({ id: 'Device' });

/**
 * `POST /v1/me/devices`. **Strict**, so a field the endpoint does not accept is a `400`
 * naming it rather than a silent no-op.
 *
 * The field most worth rejecting loudly is `deviceId`: a client that sent one would be
 * asking for an upsert, and rotation is delete-then-create by decision (P5-16 rule 2). Being
 * told is better than having it quietly ignored and then wondering why the id came back
 * different.
 */
export const registerDeviceInput = z
  .strictObject({
    expoPushToken,
    platform: devicePlatform,
    deviceName: deviceName.optional(),
  })
  .meta({ id: 'RegisterDeviceInput' });

/**
 * What a `DELETE` acknowledges: the id that is now gone.
 *
 * A body rather than a `204`, because `api-contract.md` §1 says every endpoint returns the
 * envelope and lists `200`/`201` as the success statuses — and a `204` carries no body, so it
 * cannot carry one. Naming the id makes the response self-describing in a log or a replayed
 * request rather than an empty success that could have been about anything.
 */
export const deletedDevice = z.object({ deviceId }).meta({ id: 'DeletedDevice' });
