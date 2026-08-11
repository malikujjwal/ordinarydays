import type { Device } from '@od/shared/types';
import { monotonicFactory } from 'ulid';
import { IdempotencyRaceError, type IdempotencyReceipt } from '../lib/idempotency.js';
import { deleteItem } from './base.js';
import { receiptItem } from './idempotencyRepository.js';
import { device as deviceKey } from './keys.js';
import type { StoredItem } from './migrate.js';
import { TransactionBuilder, transactWrite } from './tx.js';

/**
 * The only place a push device is written to or removed from DynamoDB —
 * `USER#<userId>` / `DEVICE#<deviceId>` (`data-model.md` §3.2, §4.0a, ADR-009).
 *
 * **There is no read method here, and that is not an oversight.** Access pattern 15 — every
 * device for a user — exists to serve the reminder Lambda's fan-out, which is P5-13. Nothing
 * in Phase 1 reads a device: the two endpoints P1-08 ships write one and delete one, and a
 * `list` written now would be an untested public method whose only caller is two phases away.
 * P5-13 adds it beside these, using `devicePrefix` from `keys.ts`, which already exists.
 *
 * Like every repository here it **stores rather than decides**: it takes a fully-formed
 * `Device` whose id and timestamps are already set, which is what lets the service's rules be
 * tested without a database.
 */

/** The `entity` discriminator every item carries (`data-model.md` §3). */
const ENTITY = 'Device';

const SCHEMA_VERSION = 1;

/**
 * A new device id — `dev_` plus a ULID (`data-model.md` §8).
 *
 * `monotonicFactory`, not the bare `ulid()`, for the reason `newUserId` records: plain ULIDs
 * minted in the same millisecond break the tie with random bits and sort arbitrarily, which
 * is the guarantee §8 says the prefix-ULID choice was made for. Two registrations in one tick
 * is not hypothetical here — a client that retries a timed-out `POST` does exactly that, and
 * the ids it produces should order the way they happened.
 */
const nextUlid = monotonicFactory();

export function newDeviceId(): string {
  return `dev_${nextUlid()}`;
}

/**
 * Writes the device row.
 *
 * **Not an upsert, and never keyed on the token.** Token rotation is delete-then-create by
 * decision (P5-16 rule 2), so each registration is a new row with a new id; the client stores
 * the returned id and deletes it when the token changes or the user signs out. Keying on the
 * token instead would make the id unnecessary and the delete unaddressable.
 *
 * The condition is `attribute_not_exists(pk)` — a fresh ULID cannot collide, so this asserts
 * that rather than trusting it. A failure here is a bug in id generation, not a user error,
 * and it should surface as one instead of silently overwriting a row.
 */
export async function putDevice(
  userId: string,
  device: Device,
  idempotencyReceipt?: IdempotencyReceipt,
): Promise<void> {
  const item: StoredItem = {
    ...deviceKey(userId, device.deviceId),
    entity: ENTITY,
    deviceId: device.deviceId,
    expoPushToken: device.expoPushToken,
    platform: device.platform,
    ...(device.deviceName === undefined ? {} : { deviceName: device.deviceName }),
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    schemaVersion: SCHEMA_VERSION,
  };

  const builder = new TransactionBuilder(
    'putDevice',
    idempotencyReceipt === undefined ? 0 : 1,
  ).add({ Put: { Item: item, ConditionExpression: 'attribute_not_exists(pk)' } });
  const receiptIndex = builder.length;
  if (idempotencyReceipt !== undefined)
    builder.addReserved(receiptItem(idempotencyReceipt));
  await transactWrite(builder.build(), {
    operation: 'putDevice',
    onConditionFailed: (index) =>
      idempotencyReceipt !== undefined && index === receiptIndex
        ? new IdempotencyRaceError()
        : undefined,
  });
}

/**
 * Removes one device from **this user's** partition.
 *
 * Tenancy is in the key and nowhere else: `userId` comes from the resolved identity and
 * `deviceId` from the path, so another user's device id addresses a row that does not exist
 * in this partition and the conditional delete fails exactly as it does for a typo. There is
 * no ownership field to check and no way to check the wrong one.
 *
 * Throws `ConditionalCheckFailedException` when there is no such row; the service turns that
 * into the `404`.
 */
export async function deleteDevice(userId: string, deviceId: string): Promise<void> {
  await deleteItem(deviceKey(userId, deviceId), {
    // `pk` is on every stored item, so this is the cheapest existence check available and
    // needs no extra read.
    expression: 'attribute_exists(pk)',
  });
}
