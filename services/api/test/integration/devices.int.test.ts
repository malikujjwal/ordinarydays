import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { tableName } from '@od/shared/table';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalTable } from '../../scripts/create-local-table.js';

/**
 * `POST`/`DELETE /v1/me/devices` against a real DynamoDB Local (P1-08).
 *
 * The unit suite proves the handlers build the right commands. What it cannot prove is that
 * those commands do what they claim against the table: that `attribute_exists(pk)` really
 * refuses a delete of a row nobody wrote, that the row really lands where access pattern 15
 * will look for it, and — the one that matters most — that one user's device id is genuinely
 * unreachable from another user's session rather than merely filtered out.
 */
const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const NAME = process.env.TABLE_NAME ?? tableName('local');

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = NAME;
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'localsecret';

type CreateApp = typeof import('../../src/app.js').createApp;
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let createApp: CreateApp;
let base: Base;
let keys: Keys;

/** The id `LocalIdentityProvider` resolves, which is what the real app will read as. */
const DEV = 'usr_local_dev';
const OTHER = 'usr_int_devices_other';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

const admin = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

beforeAll(async () => {
  await createLocalTable(admin, NAME);
  createApp = (await import('../../src/app.js')).createApp;
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

afterAll(() => {
  admin.destroy();
});

/** Both partitions empty, so a test that seeds nothing genuinely finds nothing. */
beforeEach(async () => {
  for (const userId of [DEV, OTHER]) {
    const rows = await base.queryAll<{ pk: string; sk: string }>({
      pk: keys.userProfile(userId).pk,
    });
    await base.deleteAll(rows.map((row) => ({ pk: row.pk, sk: row.sk })));
  }
});

const asUser = (userId?: string) =>
  userId === undefined
    ? createApp()
    : createApp({ identityProvider: { resolve: () => Promise.resolve(userId) } });

const register = (body: unknown, userId?: string) =>
  asUser(userId).fetch(
    new Request('http://localhost/v1/me/devices', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    }),
  );

const unregister = (deviceId: string, userId?: string) =>
  asUser(userId).fetch(
    new Request(`http://localhost/v1/me/devices/${deviceId}`, { method: 'DELETE' }),
  );

/** Access pattern 15, run for real: every device row in one user's partition. */
const devicesOf = async (userId: string) => {
  const prefix = keys.devicePrefix(userId);
  return base.queryAll<Record<string, unknown>>(
    { pk: prefix.pk },
    { skPrefix: prefix.skPrefix },
  );
};

describe('POST /v1/me/devices', () => {
  it('writes a row access pattern 15 finds', async () => {
    const { data } = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();

    const rows = await devicesOf(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pk: `USER#${DEV}`,
      sk: `DEVICE#${data.deviceId}`,
      entity: 'Device',
      expoPushToken: TOKEN,
      platform: 'ios',
      schemaVersion: 1,
    });
  });

  it('returns a body the shared device schema accepts', async () => {
    const { device } = await import('@od/shared/schemas');

    const body = await (
      await register({
        expoPushToken: TOKEN,
        platform: 'ios',
        deviceName: "Ada's iPhone",
      })
    ).json();

    expect(device.safeParse(body.data).success).toBe(true);
  });

  it('leaks no storage attribute from the real stored row', async () => {
    const body = await (await register({ expoPushToken: TOKEN, platform: 'ios' })).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  /**
   * Rotation is delete-then-create, so two registrations are two rows with two ids — not one
   * row upserted. A client that skipped the `DELETE` leaves both, and P5-13's receipt cleanup
   * is what eventually removes the stale one.
   */
  it('registers a second device rather than replacing the first', async () => {
    const first = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();
    const second = await (
      await register({ expoPushToken: 'ExpoPushToken[second]', platform: 'ios' })
    ).json();

    expect(second.data.deviceId).not.toBe(first.data.deviceId);
    expect(await devicesOf(DEV)).toHaveLength(2);
  });

  it('400s on a malformed token and writes nothing', async () => {
    const res = await register({ expoPushToken: 'a'.repeat(64), platform: 'ios' });

    expect(res.status).toBe(400);
    expect(await devicesOf(DEV)).toHaveLength(0);
  });
});

describe('DELETE /v1/me/devices/:deviceId', () => {
  it('removes the row it names', async () => {
    const { data } = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();

    const res = await unregister(data.deviceId);

    expect(res.status).toBe(200);
    expect(await devicesOf(DEV)).toHaveLength(0);
  });

  it('removes only that row', async () => {
    const first = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();
    const second = await (
      await register({ expoPushToken: 'ExpoPushToken[second]', platform: 'ios' })
    ).json();

    await unregister(first.data.deviceId);

    const rows = await devicesOf(DEV);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deviceId).toBe(second.data.deviceId);
  });

  it('404s against a device nobody registered', async () => {
    const res = await unregister('dev_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe('Device not found.');
  });

  /**
   * A sign-out `DELETE` that could not be confirmed is retried on next launch (P5-16 rule 3).
   * The retry lands here, and `404` is the honest answer: the row is already gone.
   */
  it('404s on a repeat of a delete that already succeeded', async () => {
    const { data } = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();

    expect((await unregister(data.deviceId)).status).toBe(200);
    expect((await unregister(data.deviceId)).status).toBe(404);
  });
});

/**
 * **The tenancy assertions against a real table.** The partition key comes from the resolved
 * identity and never from the request, so there is nothing a caller can send that reaches
 * another user's rows — and that must be true before Phase 4 makes it matter.
 */
describe('one user cannot reach another user’s devices', () => {
  it('keeps two users’ registrations in their own partitions', async () => {
    await register({ expoPushToken: TOKEN, platform: 'ios' });
    await register({ expoPushToken: 'ExpoPushToken[theirs]', platform: 'ios' }, OTHER);

    expect(await devicesOf(DEV)).toHaveLength(1);
    expect(await devicesOf(OTHER)).toHaveLength(1);
  });

  it('404s a delete of someone else’s device id, and leaves it there', async () => {
    const { data } = await (
      await register({ expoPushToken: TOKEN, platform: 'ios' })
    ).json();

    const res = await unregister(data.deviceId, OTHER);

    expect(res.status).toBe(404);
    expect(await devicesOf(DEV)).toHaveLength(1);
  });
});
