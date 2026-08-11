import type { Device, RegisterDeviceInput } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import type { Logger } from '../lib/logger.js';
import {
  deleteDevice,
  newDeviceId,
  putDevice,
} from '../repositories/deviceRepository.js';

/**
 * Push-device registration behind `POST`/`DELETE /v1/me/devices` (P1-08).
 *
 * Thin, because the authorisation question this endpoint would otherwise have is already
 * answered by the key: a device lives in the caller's own partition, so there is no owner to
 * compare and no relationship to resolve. What is left is where the id and the timestamps
 * come from — here, not the client — and what a delete of something absent means.
 */

const NOT_FOUND = 'Device not found.';

/**
 * A stable event code a Log Insights query can filter on (`definition-of-done.md` §8 rule 2),
 * rather than an interpolated sentence.
 */
const DELETE_MISS = 'device_delete_miss';

/**
 * Registers a device and returns the stored row, **including the id the server minted**.
 *
 * The id is the whole reason this returns a body: the create body carries no `deviceId`
 * because rotation is delete-then-create rather than an upsert, so the client has no way to
 * address this row later unless the response tells it (P5-16 rule 1).
 *
 * `now` is a parameter rather than a clock read, so the timestamps are assertable without
 * freezing time (`coding-standards.md` §4.3). The same value goes to `createdAt` and
 * `updatedAt`: a device row is never edited — it is created and deleted — so the two are
 * equal for its whole life, and `updatedAt` exists because every item carries it, not because
 * anything bumps it.
 */
export async function registerDevice(
  userId: string,
  input: RegisterDeviceInput,
  now: string,
  receiptFor?: (device: Device) => IdempotencyReceipt,
): Promise<Device> {
  const device: Device = {
    deviceId: newDeviceId(),
    expoPushToken: input.expoPushToken,
    platform: input.platform,
    ...(input.deviceName === undefined ? {} : { deviceName: input.deviceName }),
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };

  await putDevice(userId, device, receiptFor?.(device));

  return device;
}

/**
 * Removes a device, or `404`s when this user has no such device.
 *
 * ## Why a miss is `404` rather than a silent success
 *
 * Two callers reach this with an id that is not there. A **stranger** using someone else's
 * device id gets `404` — the required answer, and it falls out of the key rather than being
 * enforced: the id addresses a row in *their* partition, which does not exist
 * (`definition-of-done.md` §7 rule 5). A **client retrying a sign-out `DELETE` it could not
 * confirm** also gets `404`, and for that caller `404` means "already gone", which is the
 * outcome it wanted; P5-16 calls that retry opportunistic and the receipt cleanup in P5-13 is
 * the backstop when it never lands at all.
 *
 * Answering `200` for both would make the endpoint unable to say anything true, and would
 * make a client bug — sending an id it never received — indistinguishable from success.
 */
export async function unregisterDevice(
  userId: string,
  deviceId: string,
  log?: Logger,
): Promise<void> {
  try {
    await deleteDevice(userId, deviceId);
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      // `deviceId` is a server-minted opaque id, not content: it carries nothing about the
      // person or the device and is safe to log (`security-privacy.md` §3).
      log?.warn({ event: DELETE_MISS, userId, deviceId }, 'no such device for this user');
      throw new AppError('not_found', NOT_FOUND);
    }
    throw error;
  }
}
