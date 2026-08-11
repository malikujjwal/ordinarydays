import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = 'od-main-local';
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';

import type { createApp as CreateApp } from '../app.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

let createApp: typeof CreateApp;

const DEV = 'usr_local_dev';

const profileOf = (userId: string) => ({
  pk: `USER#${userId}`,
  sk: 'PROFILE',
  entity: 'User',
  userId,
  displayName: 'Dev',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
});

beforeEach(async () => {
  ddbMock.reset();
  vi.resetModules();
  createApp = (await import('../app.js')).createApp;
});

/**
 * The profile write, picked out of every `UpdateCommand` the request sent.
 *
 * `/v1/me` is an `authenticated` route, so `rateLimit` (chain position 9) issues its own
 * `UpdateCommand` against a `RATE#` key before the handler runs. Asserting on
 * `commandCalls(UpdateCommand)[0]` therefore inspects the *counter*, not the profile — which
 * is how the first version of this file managed to assert that a reminder clear produced
 * `SET #ttl = :ttl ADD #n :one`.
 */
const profileUpdates = () =>
  ddbMock
    .commandCalls(UpdateCommand)
    .map((call) => call.args[0].input)
    .filter((input) => String(input.Key?.pk).startsWith('USER#'));

/** Matches only the profile row, so the rate limiter's counter is unaffected. */
const profileKey = (userId = DEV) => ({ pk: `USER#${userId}`, sk: 'PROFILE' });

const get = (app: ReturnType<typeof CreateApp>) =>
  app.fetch(new Request('http://localhost/v1/me'));

const patch = (app: ReturnType<typeof CreateApp>, body: unknown) =>
  app.fetch(
    new Request('http://localhost/v1/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('GET /v1/me', () => {
  /**
   * In local mode this returns the seeded dev profile rather than a `401`, and **that falls
   * out of the identity seam rather than being special-cased**: `identity` resolved
   * `usr_local_dev`, the handler read `c.get('userId')`, the repository loaded that profile.
   * There is no local branch anywhere in the path (P1-01, P1-07).
   */
  it('returns the profile for whoever identity resolved', async () => {
    ddbMock.on(GetCommand).resolves({ Item: profileOf(DEV) });

    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.userId).toBe(DEV);
    expect(body.data.displayName).toBe('Dev');
    expect(body.meta.requestId).toMatch(/^req_/);
  });

  it('reads USER#<id> / PROFILE', async () => {
    ddbMock.on(GetCommand).resolves({ Item: profileOf(DEV) });

    await get(createApp());

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      pk: `USER#${DEV}`,
      sk: 'PROFILE',
    });
  });

  it('never leaks the storage attributes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: profileOf(DEV) });

    const body = await (await get(createApp())).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  /**
   * The message says nothing about the seed script. The same path serves a Phase 4 user
   * whose post-confirmation trigger failed, and a production error must not describe a
   * developer workflow — the hint goes in the log line instead.
   */
  it('404s with a message that does not mention a developer workflow', async () => {
    ddbMock.on(GetCommand).resolves({});

    const res = await get(createApp());
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe('Profile not found.');
    expect(body.error.message).not.toMatch(/seed|script|pnpm/i);
  });

  /**
   * **The first tenancy assertion in the codebase**, written while there is only one tenant
   * (P1-07). A second user gets their own partition, so the dev profile is not theirs to
   * read — and that must be true before Phase 4 makes it matter.
   */
  it('does not return the dev profile to a different user', async () => {
    // The table holds only the dev profile; a read for anyone else finds nothing.
    ddbMock.on(GetCommand).callsFake((input) => ({
      Item: input.Key.pk === `USER#${DEV}` ? profileOf(DEV) : undefined,
    }));

    const app = createApp({
      identityProvider: { resolve: () => Promise.resolve('usr_someone_else') },
    });
    const res = await get(app);

    expect(res.status).toBe(404);
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input.Key?.pk).toBe(
      'USER#usr_someone_else',
    );
  });
});

describe('PATCH /v1/me', () => {
  it('updates a subset and returns the stored profile', async () => {
    ddbMock
      .on(UpdateCommand)
      .resolves({ Attributes: { ...profileOf(DEV), displayName: 'Ada' } });

    const res = await patch(createApp(), { displayName: 'Ada' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.displayName).toBe('Ada');
  });

  it('bumps updatedAt', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: profileOf(DEV) });

    await patch(createApp(), { displayName: 'Ada' });

    const values = profileUpdates()[0]?.ExpressionAttributeValues;
    expect(String(values?.[':updatedAt'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * The schema is strict, so a field the endpoint does not accept is a `400` naming it
   * rather than a silent no-op. `email` belongs to the auth flow; a client that tried to set
   * it should be told.
   */
  it.each(['email', 'onboardingState', 'cognitoSub', 'userId', 'schemaVersion'])(
    '400s on %s, naming it',
    async (field) => {
      const res = await patch(createApp(), { [field]: 'anything' });
      const body = await res.json();

      expect(res.status).toBe(400);
      // The contract envelope, not zValidator's own body — see the failure hook in `me.ts`.
      expect(body.error.code).toBe('validation_failed');
      expect(body.error.requestId).toMatch(/^req_/);
      expect(JSON.stringify(body.error.details)).toContain(field);
      expect(profileUpdates()).toHaveLength(0);
    },
  );

  it('400s on an offset outside the accepted range', async () => {
    const res = await patch(createApp(), { defaultReminderOffset: 60 });

    expect(res.status).toBe(400);
    expect(profileUpdates()).toHaveLength(0);
  });

  it('accepts null to clear the reminder default to Off', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: profileOf(DEV) });

    const res = await patch(createApp(), { defaultReminderOffset: null });

    expect(res.status).toBe(200);
    expect(String(profileUpdates()[0]?.UpdateExpression)).toContain('REMOVE');
  });

  it('accepts 0, which is At the time and not Off', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: profileOf(DEV) });

    const res = await patch(createApp(), { defaultReminderOffset: 0 });

    expect(res.status).toBe(200);
    expect(String(profileUpdates()[0]?.UpdateExpression)).not.toContain('REMOVE');
  });

  /**
   * The conditional write fails when the row is absent. Mapped to `404` rather than left to
   * `errorHandler`'s DynamoDB table, which turns a `ConditionalCheckFailedException` into
   * `409 conflict` — a status telling the client to resolve a concurrent edit against a
   * profile that does not exist.
   */
  it('404s rather than 409s when the profile is missing', async () => {
    const failure = new Error('The conditional request failed');
    failure.name = 'ConditionalCheckFailedException';
    // Scoped to the profile key: rejecting *every* UpdateCommand would fail the rate
    // limiter's counter instead and answer 429, which is how this test first "passed".
    ddbMock.on(UpdateCommand, { Key: profileKey() }).rejects(failure);

    const res = await patch(createApp(), { displayName: 'Ada' });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
  });

  /** `PATCH` is idempotent by nature and is not a POST, so it needs no key. */
  it('needs no Idempotency-Key', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: profileOf(DEV) });

    const res = await patch(createApp(), { displayName: 'Ada' });

    expect(res.status).toBe(200);
  });
});
