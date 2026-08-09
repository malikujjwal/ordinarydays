import type { z } from 'zod';
import { deletedDevice, device } from '../../schemas/device.js';
import { envelope } from '../../schemas/envelope.js';
import { type patchUserInput, user } from '../../schemas/user.js';
import type { Device, RegisterDeviceInput, User } from '../../types/index.js';
import type { HttpClient } from '../http.js';

/**
 * The `/v1/me` endpoint functions (`api-contract.md` §2.1).
 *
 * ## None of these knows whether a token exists
 *
 * `getMe()` is the **same call** in Phase 1 and in Phase 4. Today it reaches an API whose
 * `LocalIdentityProvider` resolves `usr_local_dev`; then it will carry a Cognito subject. The
 * entire difference lives inside the `AuthTokenProvider` handed to the client at
 * construction, which is what the seam is for — there is no branch here to update, and a
 * branch here would be the bug.
 */

export const userResponse = envelope(user);
export const deviceResponse = envelope(device);
export const deletedDeviceResponse = envelope(deletedDevice);

export type PatchUserInput = z.infer<typeof patchUserInput>;

/** `GET /v1/me`. The profile, preferences, timezone and currency. */
export function getMe(client: HttpClient, signal?: AbortSignal): Promise<User> {
  return client
    .request({
      method: 'GET',
      path: '/v1/me',
      schema: userResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as User);
}

/**
 * `PATCH /v1/me`.
 *
 * The body is the strict subset the endpoint accepts, so a field belonging to the auth flow
 * cannot be sent by construction rather than being rejected on arrival.
 *
 * **`defaultReminderOffset: null` is meaningful** and is not the same as omitting it: `null`
 * clears the default to *Off*, `0` is a real *at the time* reminder, and absent means leave
 * it alone (ADR-047). A caller that collapses the three loses one of them.
 */
export function patchMe(
  client: HttpClient,
  patch: PatchUserInput,
  signal?: AbortSignal,
): Promise<User> {
  return client
    .request({
      method: 'PATCH',
      path: '/v1/me',
      schema: userResponse,
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as User);
}

/**
 * `POST /v1/me/devices`.
 *
 * `idempotencyKey` is **required**, for the reason `createActivity` records: this creates,
 * and a retried registration that actually succeeded would otherwise leave a device row whose
 * id the client never learned and can therefore never delete.
 *
 * The returned `deviceId` is the only way the caller can ever remove this registration — the
 * request carries none, because rotation is delete-then-create rather than an upsert (P5-16).
 * Store it.
 */
export function registerDevice(
  client: HttpClient,
  input: RegisterDeviceInput,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<Device> {
  return client
    .request({
      method: 'POST',
      path: '/v1/me/devices',
      schema: deviceResponse,
      body: input,
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data as Device);
}

/**
 * `DELETE /v1/me/devices/:deviceId`.
 *
 * Called on sign-out **before** tokens are cleared, and on token rotation — skipping it is
 * how a resold or shared device keeps receiving a stranger's reminders (`auth.md` §3.4).
 *
 * A `404` means the device is already gone, which for a retried sign-out is success. Callers
 * on that path should treat it as such rather than surfacing it; it is left as a thrown
 * `ApiError` here because the client cannot know which path it is on, and swallowing a `404`
 * for every caller would hide a genuine client bug — an id it never received.
 */
export function unregisterDevice(
  client: HttpClient,
  deviceId: string,
  signal?: AbortSignal,
): Promise<{ deviceId: string }> {
  return client
    .request({
      method: 'DELETE',
      path: `/v1/me/devices/${deviceId}`,
      schema: deletedDeviceResponse,
      ...(signal === undefined ? {} : { signal }),
    })
    .then((response) => response.data);
}

export type { RegisterDeviceInput };
