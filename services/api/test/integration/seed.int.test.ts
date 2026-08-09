import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `pnpm seed:local` against a real DynamoDB Local (P1-21).
 *
 * **Its own table**, not the shared `od-main-local`, because `--reset` drops and rebuilds
 * whatever it is pointed at. `fileParallelism: false` means nothing else is running, but a
 * test that destroys the table its siblings use is one scheduling change away from being a
 * mystery, and isolating it costs one environment variable.
 */
const ENDPOINT = process.env.DDB_ENDPOINT ?? 'http://localhost:8000';
const NAME = 'od-main-seedtest';

process.env.STAGE = 'local';
process.env.AUTH_MODE = 'local';
process.env.TABLE_NAME = NAME;
process.env.MEDIA_BUCKET = 'od-media-local';
process.env.WEB_ORIGINS = 'http://localhost:8081';
process.env.LOG_LEVEL = 'fatal';
process.env.DDB_ENDPOINT = ENDPOINT;
process.env.AWS_ACCESS_KEY_ID ??= 'local';
process.env.AWS_SECRET_ACCESS_KEY ??= 'localsecret';

type Seed = typeof import('../../scripts/seed-local.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type CreateApp = typeof import('../../src/app.js').createApp;

let seed: Seed;
let base: Base;
let keys: Keys;
let createApp: CreateApp;

const DEV = 'usr_local_dev';

const admin = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
});

beforeAll(async () => {
  seed = await import('../../scripts/seed-local.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  createApp = (await import('../../src/app.js')).createApp;

  // A clean table, whatever a previous run left.
  await seed.seedLocal({ reset: true });
});

afterAll(() => {
  admin.destroy();
});

/** Everything in the dev user's partition: the profile plus one index entry per activity. */
const userRows = () =>
  base.queryAll<Record<string, unknown>>({ pk: keys.userProfile(DEV).pk });

describe('what a seed writes', () => {
  it('writes the profile and one index entry per activity', async () => {
    const rows = await userRows();

    expect(rows.filter((row) => row.entity === 'User')).toHaveLength(1);
    expect(rows.filter((row) => row.entity === 'ActivityIndex')).toHaveLength(24);
  });

  /**
   * The profile round-trips through the endpoint a screen actually calls, not just through a
   * repository read — a seed that writes a shape `GET /v1/me` rejects is a seed that looks
   * fine in the table and breaks the first screen.
   */
  it('serves the seeded profile through GET /v1/me', async () => {
    const res = await createApp().fetch(new Request('http://localhost/v1/me'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      userId: DEV,
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 0,
      onboardingState: 'done',
    });
  });

  /**
   * The fixture sets a saved default so the ADR-047 path is exercised by ordinary use. A real
   * new profile omits it and ships Off — this asserts the fixture, not the product default.
   */
  it('configures a saved reminder default, so that path is exercised', async () => {
    const body = await (
      await createApp().fetch(new Request('http://localhost/v1/me'))
    ).json();

    expect(body.data.defaultReminderOffset).toBe(-15);
    expect(body.data.quietHours).toEqual({ enabled: true, start: '22:00', end: '07:00' });
  });

  /**
   * **Every seeded row parsed by the shared schema.** This is what catches a seed that drifts
   * from the schema the day it drifts, rather than the day somebody opens a screen.
   */
  it('writes activities the shared schema accepts', async () => {
    const { activity } = await import('@od/shared/schemas');
    const repo = await import('../../src/repositories/activityRepository.js');

    const ids = (await userRows())
      .filter((row) => row.entity === 'ActivityIndex')
      .map((row) => String(row.activityId));

    for (const id of ids) {
      const stored = await repo.getActivityMeta(id);
      const parsed = activity.safeParse(stored);
      expect(
        parsed.success,
        `${id} did not parse: ${JSON.stringify(parsed.error?.issues)}`,
      ).toBe(true);
    }
  });
});

/**
 * The spread P1-21 asks for. Each of these is a row that breaks something — a bucket with no
 * data, a title that overflows, a meal long enough to scroll — and the point of seeding them
 * is that they exist before the layout does.
 */
describe('the spread', () => {
  const buckets = async () => {
    const rows = (await userRows()).filter((row) => row.entity === 'ActivityIndex');
    return rows.reduce<Record<string, number>>((counts, row) => {
      const bucket = String(row.gsi1pk).split('#').pop() ?? '?';
      counts[bucket] = (counts[bucket] ?? 0) + 1;
      return counts;
    }, {});
  };

  it('fills every bucket a Phase 1 entity can reach', async () => {
    const counts = await buckets();

    // Undated tasks, undated plans, and dated things. `#R` needs recurrence, which P1-21
    // explicitly does not seed.
    expect(counts.N).toBeGreaterThan(0);
    expect(counts.P).toBeGreaterThan(0);
    expect(counts.S).toBeGreaterThan(0);
    expect(counts.R).toBeUndefined();
  });

  it('covers all five Plan kinds and Task', async () => {
    const types = new Set(
      (await userRows())
        .filter((row) => row.entity === 'ActivityIndex')
        .map((row) => String(row.type)),
    );

    expect([...types].sort()).toEqual([
      'custom',
      'event',
      'meal',
      'outing',
      'task',
      'watch',
    ]);
  });

  it('includes the rows that break layouts', async () => {
    const { MAX_TITLE_LEN, MAX_NOTES_LEN, MAX_INGREDIENTS } = await import(
      '@od/shared/constants'
    );
    const repo = await import('../../src/repositories/activityRepository.js');

    const ids = (await userRows())
      .filter((row) => row.entity === 'ActivityIndex')
      .map((row) => String(row.activityId));
    const rows = await Promise.all(ids.map((id) => repo.getActivityMeta(id)));

    expect(rows.some((row) => (row?.title.length ?? 0) === MAX_TITLE_LEN)).toBe(true);
    expect(rows.some((row) => (row?.notes?.length ?? 0) === MAX_NOTES_LEN)).toBe(true);
    expect(
      rows.some(
        (row) =>
          row?.details.kind === 'meal' &&
          (row.details.ingredients?.length ?? 0) === MAX_INGREDIENTS,
      ),
    ).toBe(true);
    expect(rows.some((row) => row?.location?.address !== undefined)).toBe(true);
    expect(rows.some((row) => row?.status === 'cancelled')).toBe(true);
  });

  /** Dates are relative to today, so the seed stays plausible rather than ageing out. */
  it('spans past, today and future', async () => {
    const repo = await import('../../src/repositories/activityRepository.js');
    const today = new Date().toISOString().slice(0, 10);

    const ids = (await userRows())
      .filter((row) => row.entity === 'ActivityIndex')
      .map((row) => String(row.activityId));
    const dates = (await Promise.all(ids.map((id) => repo.getActivityMeta(id))))
      .map((row) => row?.schedule?.date)
      .filter((date): date is string => date !== undefined);

    expect(dates.some((date) => date < today)).toBe(true);
    expect(dates.some((date) => date === today)).toBe(true);
    expect(dates.some((date) => date > today)).toBe(true);
  });
});

/**
 * **Idempotent by key, not by check.** Ids are derived from a fixed seed, so a second run
 * overwrites the first rather than appending — asserted rather than assumed, because the
 * failure mode is silent duplication that only shows up as a doubled list.
 */
describe('running it twice', () => {
  it('produces the same item count', async () => {
    const before = await userRows();

    await seed.seedLocal();
    const after = await userRows();

    expect(after).toHaveLength(before.length);
  });

  it('produces the same ids, not a second set', async () => {
    const ids = (rows: Record<string, unknown>[]) =>
      rows
        .filter((row) => row.entity === 'ActivityIndex')
        .map((row) => String(row.activityId))
        .sort();

    const before = ids(await userRows());
    await seed.seedLocal();

    expect(ids(await userRows())).toEqual(before);
  });

  it('reports what it wrote', async () => {
    const result = await seed.seedLocal();

    expect(result).toMatchObject({ profile: DEV, activities: 24, reset: false });
  });
});

/**
 * The guard, in the same throw-don't-warn shape as P1-02's startup check. Both conditions,
 * not either — and `--reset` is what makes getting this wrong a dropped table rather than
 * some stray rows.
 */
describe('it refuses to run anywhere but local', () => {
  const withEnv = async (
    changes: Record<string, string | undefined>,
    run: () => Promise<unknown>,
  ) => {
    const saved = Object.fromEntries(
      Object.keys(changes).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, changes);
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
    }
    try {
      return await run().then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      Object.assign(process.env, saved);
    }
  };

  it.each(['dev', 'prod', undefined])('refuses STAGE=%s', async (stage) => {
    const error = await withEnv({ STAGE: stage }, () => seed.seedLocal());

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('refuses to run');
  });

  it('refuses when DDB_ENDPOINT is unset, so it can never reach a deployed table', async () => {
    const error = await withEnv({ DDB_ENDPOINT: undefined }, () => seed.seedLocal());

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('DDB_ENDPOINT');
  });

  it('refuses before touching the table, not after', async () => {
    const before = await userRows();

    await withEnv({ STAGE: 'prod' }, () => seed.seedLocal({ reset: true }));

    // A guard that ran after `--reset` would have dropped the table by now.
    expect(await userRows()).toHaveLength(before.length);
  });
});
