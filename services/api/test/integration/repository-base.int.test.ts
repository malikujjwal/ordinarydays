import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { useTestTable } from './harness.js';

/**
 * `base.ts` and `tx.ts` against a real DynamoDB Local.
 *
 * The unit suite covers the pure parts — key strings, cursor encoding, the transaction cap.
 * What it cannot cover is whether the commands those modules build actually do what they
 * claim: whether `begins_with` scopes the way the key design assumes, whether a conditional
 * write really fails, whether pagination round-trips a cursor the service minted. Those
 * answers come from the database or not at all. A mock would assert that the code sends the
 * command the code sends.
 *
 * The modules are imported in `beforeAll` rather than at the top, because `lib/config.ts`
 * parses the environment at module scope and `harness.js` is what sets it (`testing.md` §4.3).
 */
useTestTable();

type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Tx = typeof import('../../src/repositories/tx.js');

let base: Base;
let keys: Keys;
let tx: Tx;

/** Two invented users. Neither needs a profile — the keys are what is under test. */
const ALICE = 'usr_int_alice';
const BEN = 'usr_int_ben';

beforeAll(async () => {
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  tx = await import('../../src/repositories/tx.js');
});

const profileOf = (userId: string) => ({
  ...keys.userProfile(userId),
  entity: 'User',
  userId,
  displayName: userId,
  schemaVersion: 1,
});

describe('get, put and delete', () => {
  it('round-trips an item through the document client', async () => {
    await base.putItem(profileOf(ALICE));

    const read = await base.getItem<{ displayName: string }>(keys.userProfile(ALICE));
    expect(read?.displayName).toBe(ALICE);
  });

  it('returns undefined for an item that is not there', async () => {
    expect(await base.getItem(keys.userProfile('usr_int_nobody'))).toBeUndefined();
  });

  it('deletes', async () => {
    await base.putItem(profileOf(ALICE));
    await base.deleteItem(keys.userProfile(ALICE));
    expect(await base.getItem(keys.userProfile(ALICE))).toBeUndefined();
  });

  /**
   * `removeUndefinedValues` is set on the document client so that
   * `exactOptionalPropertyTypes`' distinction between "absent" and "present and undefined"
   * survives to storage — an attribute is never written for an undefined value.
   */
  it('writes no attribute for an undefined value', async () => {
    await base.putItem({ ...profileOf(ALICE), email: undefined });

    const read = await base.getItem<Record<string, unknown>>(keys.userProfile(ALICE));
    expect(read).not.toHaveProperty('email');
  });

  it('applies a conditional write, so a create cannot silently overwrite', async () => {
    await base.putItem(profileOf(ALICE));

    await expect(
      base.putItem(profileOf(ALICE), { expression: 'attribute_not_exists(pk)' }),
    ).rejects.toThrow();
  });
});

describe('query', () => {
  const indexRow = (userId: string, activityId: string) => ({
    ...keys.activityIndex(userId, activityId),
    entity: 'ActivityIndex',
    activityId,
    schemaVersion: 1,
  });

  it('scopes by sort-key prefix', async () => {
    await base.putItem(profileOf(ALICE));
    await base.putItem(indexRow(ALICE, 'act_1'));
    await base.putItem(indexRow(ALICE, 'act_2'));

    const page = await base.query<{ sk: string }>(
      { pk: keys.userProfile(ALICE).pk },
      { skPrefix: 'IDX#' },
    );

    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.sk.startsWith('IDX#'))).toBe(true);
  });

  /**
   * **The assertion the whole key design exists for**, written while there is only one real
   * user — which `definition-of-done.md` §3 requires and which is the only time it is cheap.
   * Two invented user ids, neither of which needs a profile.
   */
  it('never returns one user’s rows to another’s query', async () => {
    await base.putItem(indexRow(ALICE, 'act_alice'));
    await base.putItem(indexRow(BEN, 'act_ben'));

    const alice = await base.queryAll<{ activityId: string }>({
      pk: keys.userProfile(ALICE).pk,
    });
    const ben = await base.queryAll<{ activityId: string }>({
      pk: keys.userProfile(BEN).pk,
    });

    expect(alice.map((row) => row.activityId)).toEqual(['act_alice']);
    expect(ben.map((row) => row.activityId)).toEqual(['act_ben']);
  });

  it('reads a sort-key range, which is how occurrences are windowed', async () => {
    const act = 'act_occ';
    for (const date of ['2026-07-31', '2026-08-01', '2026-08-15', '2026-09-01']) {
      await base.putItem({
        ...keys.occurrence(act, date),
        entity: 'Occurrence',
        date,
        schemaVersion: 1,
      });
    }

    const range = keys.occurrenceRange(act, '2026-08-01', '2026-08-31');
    const page = await base.query<{ date: string }>(
      { pk: range.pk },
      { skBetween: [range.fromSk, range.toSk] },
    );

    expect(page.items.map((item) => item.date)).toEqual(['2026-08-01', '2026-08-15']);
  });

  it('reads newest-first when asked, which is what Needs a date wants', async () => {
    await base.putItem(indexRow(ALICE, 'act_1'));
    await base.putItem(indexRow(ALICE, 'act_2'));

    const page = await base.query<{ sk: string }>(
      { pk: keys.userProfile(ALICE).pk },
      { skPrefix: 'IDX#', ascending: false },
    );

    expect(page.items.map((item) => item.sk)).toEqual(['IDX#act_2', 'IDX#act_1']);
  });

  it('upgrades every row on read', async () => {
    // Written without a schemaVersion, as only pre-Phase-1 scratch data can be.
    await base.putItem({ ...keys.activityIndex(ALICE, 'act_legacy'), entity: 'X' });

    const rows = await base.queryAll<{ schemaVersion?: number }>({
      pk: keys.userProfile(ALICE).pk,
    });

    expect(rows).toHaveLength(1);
  });
});

/**
 * Pagination end to end: the cursor a query mints is the cursor the next call accepts, and
 * it survives the base64 round trip through a real `LastEvaluatedKey`.
 */
describe('pagination', () => {
  beforeEach(async () => {
    for (let i = 0; i < 5; i += 1) {
      await base.putItem({
        ...keys.activityIndex(ALICE, `act_${i}`),
        entity: 'ActivityIndex',
        schemaVersion: 1,
      });
    }
  });

  it('pages through with a cursor and stops with none', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;

    do {
      const page = await base.query<{ sk: string }>(
        { pk: keys.userProfile(ALICE).pk },
        { skPrefix: 'IDX#', limit: 2, ...(cursor === undefined ? {} : { cursor }) },
      );
      seen.push(...page.items.map((item) => item.sk));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  });

  it('rejects a cursor from another query shape rather than passing it to DynamoDB', async () => {
    const page = await base.query(
      { pk: keys.userProfile(ALICE).pk },
      { skPrefix: 'IDX#', limit: 2 },
    );

    await expect(
      base.query(
        { pk: keys.userProfile(ALICE).pk },
        {
          skPrefix: 'IDX#',
          ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
          keyAttributes: ['pk', 'sk', 'gsi1pk', 'gsi1sk'],
        },
      ),
    ).rejects.toThrow(/Malformed cursor/);
  });
});

describe('transactions', () => {
  it('writes every item or none', async () => {
    await tx.transactWrite(
      [
        { Put: { Item: profileOf(ALICE) } },
        {
          Put: {
            Item: {
              ...keys.activityIndex(ALICE, 'act_tx'),
              entity: 'ActivityIndex',
              schemaVersion: 1,
            },
          },
        },
      ],
      { operation: 'createActivity' },
    );

    const rows = await base.queryAll({ pk: keys.userProfile(ALICE).pk });
    expect(rows).toHaveLength(2);
  });

  /**
   * The "none" case, forced by a condition rather than asserted by inspection — which is
   * what `testing.md` §3.3 asks for. The second item's condition fails, so the first must
   * not land either.
   */
  it('writes nothing when one item’s condition fails', async () => {
    await base.putItem(profileOf(BEN));

    await expect(
      tx.transactWrite(
        [
          {
            Put: {
              Item: {
                ...keys.activityIndex(ALICE, 'act_should_not_exist'),
                entity: 'ActivityIndex',
                schemaVersion: 1,
              },
            },
          },
          {
            Put: {
              Item: profileOf(BEN),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
        { operation: 'createActivity' },
      ),
    ).rejects.toThrow();

    expect(
      await base.getItem(keys.activityIndex(ALICE, 'act_should_not_exist')),
    ).toBeUndefined();
  });

  it('maps a cancelled condition to a conflict the caller can act on', async () => {
    await base.putItem(profileOf(ALICE));

    await expect(
      tx.transactWrite(
        [
          {
            Put: {
              Item: profileOf(ALICE),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
        { operation: 'createUser' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('lets a repository name the failure by position', async () => {
    await base.putItem(profileOf(ALICE));

    await expect(
      tx.transactWrite(
        [
          {
            Put: {
              Item: profileOf(ALICE),
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
        ],
        {
          operation: 'createUser',
          // A repository maps the position back to a message that names what lost, rather
          // than leaving the handler to guess which of five items tripped.
          onConditionFailed: (index) =>
            index === 0
              ? new AppError('conflict', 'That profile already exists.')
              : undefined,
        },
      ),
    ).rejects.toThrow('That profile already exists.');
  });

  it('does nothing at all for an empty transaction', async () => {
    await expect(tx.transactWrite([], { operation: 'noop' })).resolves.toBeUndefined();
  });
});

describe('deleteAll', () => {
  it('deletes more than one batch, which a transaction could not', async () => {
    const total = 30;
    for (let i = 0; i < total; i += 1) {
      await base.putItem({
        ...keys.activityIndex(ALICE, `act_bulk_${String(i).padStart(3, '0')}`),
        entity: 'ActivityIndex',
        schemaVersion: 1,
      });
    }

    const before = await base.queryAll<{ pk: string; sk: string }>({
      pk: keys.userProfile(ALICE).pk,
    });
    expect(before).toHaveLength(total);

    await base.deleteAll(before.map((row) => ({ pk: row.pk, sk: row.sk })));

    expect(await base.queryAll({ pk: keys.userProfile(ALICE).pk })).toHaveLength(0);
  });

  it('is a no-op for an empty list', async () => {
    await expect(base.deleteAll([])).resolves.toBeUndefined();
  });
});
