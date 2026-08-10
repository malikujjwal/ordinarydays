import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

/**
 * The idempotency record against a real DynamoDB Local (P1-04).
 *
 * The unit suite proves the middleware builds the right commands and branches the right way.
 * What it cannot prove is the one property the whole design rests on: that
 * `attribute_not_exists(pk)` **actually rejects the second writer**. A mock returns whatever
 * it was told to; only the database can answer whether two concurrent claims on one key
 * produce exactly one winner. That is the race a duplicate create would come through, so it
 * is asserted here or nowhere (`testing.md` §4.2).
 */
useTestTable();

type Repo = typeof import('../../src/repositories/idempotencyRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');

let repo: Repo;
let base: Base;
let keys: Keys;

const USER = 'usr_int_idem';
const OTHER_USER = 'usr_int_idem_other';
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

/**
 * A fresh UUID-shaped key per test.
 *
 * A plain counter is enough now that the table is this file's alone and empty at the start of
 * every test. It was not before: an idempotency record lives in its own partition,
 * `IDEM#<userId>#<key>` rather than under `USER#<userId>`, so no partition sweep could reach
 * it — the first version of this file passed once and then failed on every later run with
 * `reserved` coming back `in-flight`, and was fixed by mixing the clock into every key and
 * deleting each one in an `afterEach`. P1-28's table-per-file made both unnecessary.
 */
let counter = 0;
const nextKey = () => {
  counter += 1;
  return `9f8e7d6c-8b86-d011-b42d-${String(counter).padStart(12, '0')}`;
};

beforeAll(async () => {
  repo = await import('../../src/repositories/idempotencyRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
});

describe('claiming a key', () => {
  it('reserves a key nobody holds', async () => {
    const result = await repo.reserve(USER, nextKey(), 'POST /v1/things', NOW);
    expect(result.kind).toBe('reserved');
  });

  /**
   * P1-04 asks for this pinned by a test rather than by intent. A bare `IDEM#<key>` would
   * let one user's client-generated key return another user's stored response — a security
   * defect, not a shorthand (`data-model.md` §3.4).
   */
  it('writes the record at IDEM#<userId>#<key>, literally', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);

    const item = await base.getItem<{ pk: string; sk: string }>({
      pk: `IDEM#${USER}#${key}`,
      sk: 'META',
    });

    expect(item).toBeDefined();
    expect(item?.pk).toBe(`IDEM#usr_int_idem#${key}`);
  });

  it('stores a ttl 24 hours out', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);

    const item = await base.getItem<{ ttl: number }>(keys.idempotency(USER, key));
    expect(item?.ttl).toBe(Math.floor(NOW / 1000) + 24 * 60 * 60);
  });

  /**
   * The same key for two different users must not collide. This is the assertion that would
   * fail if the partition were ever narrowed to `IDEM#<key>`.
   */
  it('does not collide across users holding the same key', async () => {
    const key = nextKey();

    const mine = await repo.reserve(USER, key, 'POST /v1/things', NOW);
    const theirs = await repo.reserve(OTHER_USER, key, 'POST /v1/things', NOW);

    expect(mine.kind).toBe('reserved');
    expect(theirs.kind).toBe('reserved');
  });
});

describe('a second claim on a held key', () => {
  it('reports in-flight while the first request has stored no response', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);

    const second = await repo.reserve(USER, key, 'POST /v1/things', NOW);

    expect(second.kind).toBe('in-flight');
  });

  it('reports a replay once the first request has completed', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);
    await repo.complete(USER, key, 201, '{"data":{"id":"act_1"}}');

    const second = await repo.reserve(USER, key, 'POST /v1/things', NOW);

    expect(second.kind).toBe('replay');
    expect(second.kind === 'replay' && second.record.body).toBe(
      '{"data":{"id":"act_1"}}',
    );
    expect(second.kind === 'replay' && second.record.status).toBe(201);
  });

  /**
   * **The test this file exists for.** Two claims raced against the real database: the
   * conditional write must produce exactly one winner. A mock cannot answer this — it would
   * report whatever it was configured to report.
   */
  it('yields exactly one winner when two claims race', async () => {
    const key = nextKey();

    const results = await Promise.all([
      repo.reserve(USER, key, 'POST /v1/things', NOW),
      repo.reserve(USER, key, 'POST /v1/things', NOW),
    ]);

    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.kind !== 'reserved')).toHaveLength(1);
  });

  it('yields one winner out of five', async () => {
    const key = nextKey();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => repo.reserve(USER, key, 'POST /v1/things', NOW)),
    );

    expect(results.filter((r) => r.kind === 'reserved')).toHaveLength(1);
  });
});

describe('completing and releasing', () => {
  /** The 24 hours run from when the key was first seen, not from when the handler finished. */
  it('preserves the reservation ttl when attaching the response', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);
    await repo.complete(USER, key, 201, '{"data":1}');

    const item = await base.getItem<{ ttl: number; body: string }>(
      keys.idempotency(USER, key),
    );
    expect(item?.ttl).toBe(Math.floor(NOW / 1000) + 24 * 60 * 60);
    expect(item?.body).toBe('{"data":1}');
  });

  /**
   * Without the release, a failed request would hold the key for 24 hours and the client's
   * retry — the entire reason it sent a key — would be refused until tomorrow.
   */
  it('frees the key so a retry can claim it again', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);
    await repo.release(USER, key);

    const retry = await repo.reserve(USER, key, 'POST /v1/things', NOW);
    expect(retry.kind).toBe('reserved');
  });

  it('leaves nothing behind after a release', async () => {
    const key = nextKey();
    await repo.reserve(USER, key, 'POST /v1/things', NOW);
    await repo.release(USER, key);

    expect(await base.getItem(keys.idempotency(USER, key))).toBeUndefined();
  });
});
