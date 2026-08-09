import { DeleteCommand, DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

/**
 * `POST`/`DELETE /v1/me/devices` (P1-08).
 *
 * The routes are mounted in `me.ts` — `api-contract.md` §2.1 puts devices under Me — but they
 * get their own test file because nothing here shares a fixture with the profile suite, and a
 * device test that failed inside `me.test.ts` would read as a profile regression.
 */
const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const DEVICE = 'dev_01J8XKQ2M4N5P6R7S8T9V0W1X2';

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

/**
 * The device write, picked out of every `PutCommand` the request sent.
 *
 * `/v1/me/devices` is authenticated **and** creating, so two middlewares write before the
 * handler does: `rateLimit` bumps a `RATE#` counter and `idempotency` reserves an `IDEM#`
 * record. Asserting on `commandCalls(PutCommand)[0]` would inspect one of those, not the
 * device — the mistake `me.test.ts` documents having made with the rate limiter.
 */
const devicePuts = () =>
  ddbMock
    .commandCalls(PutCommand)
    .map((call) => call.args[0].input)
    .filter((input) => String(input.Item?.sk).startsWith('DEVICE#'));

const deviceDeletes = () =>
  ddbMock
    .commandCalls(DeleteCommand)
    .map((call) => call.args[0].input)
    .filter((input) => String(input.Key?.sk).startsWith('DEVICE#'));

const key = () => crypto.randomUUID();

const register = (
  app: ReturnType<typeof CreateApp>,
  body: unknown,
  headers: Record<string, string> = { 'Idempotency-Key': key() },
) =>
  app.fetch(
    new Request('http://localhost/v1/me/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );

const unregister = (app: ReturnType<typeof CreateApp>, deviceId = DEVICE) =>
  app.fetch(
    new Request(`http://localhost/v1/me/devices/${deviceId}`, { method: 'DELETE' }),
  );

const conditionalCheckFailed = () => {
  const failure = new Error('The conditional request failed');
  failure.name = 'ConditionalCheckFailedException';
  return failure;
};

describe('POST /v1/me/devices', () => {
  it('registers a token and returns the id the server minted', async () => {
    const res = await register(createApp(), { expoPushToken: TOKEN, platform: 'ios' });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.data.deviceId).toMatch(/^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(body.data.expoPushToken).toBe(TOKEN);
    expect(body.data.platform).toBe('ios');
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  /**
   * The id is the whole reason the response has a body: the request carried none, because
   * rotation is delete-then-create rather than an upsert (P5-16 rule 2). A client that never
   * learns the id can never delete the row.
   */
  it('mints the id itself rather than taking one from the body', async () => {
    const res = await register(createApp(), {
      expoPushToken: TOKEN,
      platform: 'ios',
      deviceId: DEVICE,
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('deviceId');
    expect(devicePuts()).toHaveLength(0);
  });

  it('writes USER#<id> / DEVICE#<deviceId>', async () => {
    const res = await register(createApp(), { expoPushToken: TOKEN, platform: 'ios' });
    const { data } = await res.json();

    const item = devicePuts()[0]?.Item;
    expect(item?.pk).toBe(`USER#${DEV}`);
    expect(item?.sk).toBe(`DEVICE#${data.deviceId}`);
    expect(item?.entity).toBe('Device');
    expect(item?.schemaVersion).toBe(1);
  });

  /** A fresh ULID cannot collide; the condition asserts that rather than trusting it. */
  it('refuses to overwrite an existing row', async () => {
    await register(createApp(), { expoPushToken: TOKEN, platform: 'ios' });

    expect(devicePuts()[0]?.ConditionExpression).toBe('attribute_not_exists(pk)');
  });

  it('stores an optional deviceName', async () => {
    await register(createApp(), {
      expoPushToken: TOKEN,
      platform: 'ios',
      deviceName: "Ada's iPhone",
    });

    expect(devicePuts()[0]?.Item?.deviceName).toBe("Ada's iPhone");
  });

  /** A simulator and a device whose owner cleared the name both report none. */
  it('omits deviceName entirely when it is absent, rather than storing a null', async () => {
    const res = await register(createApp(), { expoPushToken: TOKEN, platform: 'ios' });

    expect(devicePuts()[0]?.Item).not.toHaveProperty('deviceName');
    expect(await res.json().then((body) => body.data)).not.toHaveProperty('deviceName');
  });

  it('never leaks the storage attributes', async () => {
    const body = await (
      await register(createApp(), { expoPushToken: TOKEN, platform: 'ios' })
    ).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  it.each([
    ['a raw APNs token', { expoPushToken: 'a'.repeat(64), platform: 'ios' }],
    ['a platform with no push', { expoPushToken: TOKEN, platform: 'web' }],
    ['a missing token', { platform: 'ios' }],
    ['a missing platform', { expoPushToken: TOKEN }],
  ])('400s on %s and writes nothing', async (_why, body) => {
    const res = await register(createApp(), body);

    expect(res.status).toBe(400);
    // The contract envelope, not zValidator's own body — see the failure hook in `me.ts`.
    expect((await res.json()).error.code).toBe('validation_failed');
    expect(devicePuts()).toHaveLength(0);
  });

  /**
   * The route's registry entry carries `creates`, so `idempotency` requires the header. This
   * is the assertion that the flag is actually set: without it the middleware skips the route
   * and this request would succeed.
   */
  it('requires an Idempotency-Key', async () => {
    const res = await register(
      createApp(),
      { expoPushToken: TOKEN, platform: 'ios' },
      {},
    );

    expect(res.status).toBe(400);
    expect(devicePuts()).toHaveLength(0);
  });

  /**
   * The write lands in the caller's partition, whoever that is. Nothing in the path or the
   * body names a user — which is what makes the tenancy unforgeable rather than checked.
   */
  it('writes to the partition of whoever identity resolved', async () => {
    const app = createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_someone_else') },
    });

    await register(app, { expoPushToken: TOKEN, platform: 'ios' });

    expect(devicePuts()[0]?.Item?.pk).toBe('USER#usr_someone_else');
  });
});

describe('DELETE /v1/me/devices/:deviceId', () => {
  it('removes the device and names the id that is gone', async () => {
    const res = await unregister(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.deviceId).toBe(DEVICE);
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('deletes USER#<id> / DEVICE#<deviceId>', async () => {
    await unregister(createApp());

    expect(deviceDeletes()[0]?.Key).toEqual({
      pk: `USER#${DEV}`,
      sk: `DEVICE#${DEVICE}`,
    });
    expect(deviceDeletes()[0]?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  /**
   * A stranger's device id addresses a row in *their* partition, not this caller's, so it is
   * not there — `404`, never `403`, and it falls out of the key rather than being enforced
   * (`definition-of-done.md` §7 rule 5). A client retrying a sign-out `DELETE` lands in the
   * same place, where `404` means "already gone" (P5-16 rule 3).
   */
  it('404s when this user has no such device', async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());

    const res = await unregister(createApp());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Device not found.');
  });

  it('404s rather than 409s — a missing row is not a concurrent edit', async () => {
    ddbMock.on(DeleteCommand).rejects(conditionalCheckFailed());

    expect((await unregister(createApp())).status).toBe(404);
  });

  it('deletes from the partition of whoever identity resolved', async () => {
    const app = createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_someone_else') },
    });

    await unregister(app);

    expect(deviceDeletes()[0]?.Key?.pk).toBe('USER#usr_someone_else');
  });

  /** A retry cannot produce a second deletion, so the header the `POST` needs is not one. */
  it('needs no Idempotency-Key', async () => {
    expect((await unregister(createApp())).status).toBe(200);
  });
});
