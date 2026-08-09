import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { tableName } from '@od/shared/table';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalTable } from '../../scripts/create-local-table.js';

/**
 * `GET`/`PATCH /v1/me` against a real DynamoDB Local (P1-07).
 *
 * The unit suite proves the handlers build the right commands. What it cannot prove is that
 * those commands do what they claim against the table: that `attribute_exists(pk)` really
 * refuses a patch to a profile nobody created, that a `REMOVE` really deletes the attribute
 * rather than storing a null, and — the one that matters most — that a second user's read
 * genuinely finds nothing rather than finding the dev profile.
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
const OTHER = 'usr_int_me_other';

const admin = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

const seededProfile = () => ({
  ...keys.userProfile(DEV),
  entity: 'User',
  userId: DEV,
  displayName: 'Dev',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  onboardingState: 'done',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
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

const app = () => createApp();

const get = () => app().fetch(new Request('http://localhost/v1/me'));

const patch = (body: unknown, on = app()) =>
  on.fetch(
    new Request('http://localhost/v1/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('GET /v1/me', () => {
  it('returns the seeded dev profile with every default field present', async () => {
    await base.putItem(seededProfile());

    const res = await get();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      userId: DEV,
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 0,
      onboardingState: 'done',
      schemaVersion: 1,
    });
  });

  it('returns a body the shared user schema accepts', async () => {
    await base.putItem(seededProfile());
    const { user } = await import('@od/shared/schemas');

    const body = await (await get()).json();

    expect(user.safeParse(body.data).success).toBe(true);
  });

  it('leaks no storage attribute from the real stored row', async () => {
    await base.putItem(seededProfile());

    const body = await (await get()).json();

    expect(body.data).not.toHaveProperty('pk');
    expect(body.data).not.toHaveProperty('sk');
    expect(body.data).not.toHaveProperty('entity');
  });

  it('404s against an empty table', async () => {
    const res = await get();

    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe('Profile not found.');
  });

  /**
   * **The first tenancy assertion against a real table.** The dev profile exists; a
   * different user still gets nothing, because the partition key comes from the identity
   * and not from the request. Written while there is only one tenant, which is the only
   * time it is cheap.
   */
  it('does not serve the dev profile to a different user', async () => {
    await base.putItem(seededProfile());

    const res = await createApp({
      identityProvider: { resolve: () => Promise.resolve(OTHER) },
    }).fetch(new Request('http://localhost/v1/me'));

    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/me', () => {
  it('updates a subset and leaves everything else alone', async () => {
    await base.putItem(seededProfile());

    const body = await (await patch({ displayName: 'Ada', weekStartsOn: 1 })).json();

    expect(body.data.displayName).toBe('Ada');
    expect(body.data.weekStartsOn).toBe(1);
    expect(body.data.timezone).toBe('America/New_York');
    expect(body.data.createdAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('bumps updatedAt', async () => {
    await base.putItem(seededProfile());

    const body = await (await patch({ displayName: 'Ada' })).json();

    expect(body.data.updatedAt).not.toBe('2026-08-01T00:00:00.000Z');
    expect(Date.parse(String(body.data.updatedAt))).toBeGreaterThan(0);
  });

  it('persists, so the next GET sees it', async () => {
    await base.putItem(seededProfile());
    await patch({ displayName: 'Ada' });

    const body = await (await get()).json();

    expect(body.data.displayName).toBe('Ada');
  });

  /**
   * `0` is a real *At the time* reminder and `null` is Off (ADR-047). Against the real table
   * the difference is an attribute that is present-and-zero versus one that is gone.
   */
  it('stores a zero offset and clears it with null', async () => {
    await base.putItem(seededProfile());

    await patch({ defaultReminderOffset: 0 });
    let stored = await base.getItem<Record<string, unknown>>(keys.userProfile(DEV));
    expect(stored?.defaultReminderOffset).toBe(0);

    await patch({ defaultReminderOffset: null });
    stored = await base.getItem<Record<string, unknown>>(keys.userProfile(DEV));
    expect(stored).not.toHaveProperty('defaultReminderOffset');
  });

  it('400s on a field outside the accepted list, naming it', async () => {
    await base.putItem(seededProfile());

    const res = await patch({ email: 'someone@example.com' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
    expect(JSON.stringify(body.error.details)).toContain('email');
  });

  /**
   * The conditional write refuses rather than conjuring a tenant record with three fields,
   * no `createdAt` and no `schemaVersion` for every later reader to cope with.
   */
  it('404s against a missing profile and creates nothing', async () => {
    const res = await patch({ displayName: 'Ada' });

    expect(res.status).toBe(404);
    expect(await base.getItem(keys.userProfile(DEV))).toBeUndefined();
  });
});
