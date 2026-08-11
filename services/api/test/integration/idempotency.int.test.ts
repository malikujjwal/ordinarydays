import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

useTestTable();

type Base = typeof import('../../src/repositories/base.js');
type Idempotency = typeof import('../../src/repositories/idempotencyRepository.js');
type Tx = typeof import('../../src/repositories/tx.js');
type Cleanup = typeof import('../../src/services/idempotencyCleanupService.js');

let base: Base;
let idem: Idempotency;
let tx: Tx;
let cleanup: Cleanup;

const USER = 'usr_int_idem';
const KEY = '9f8e7d6c-8b86-d011-b42d-000000000001';
const CREATED_AT = '2026-08-09T12:00:00.000Z';
const receipt = (key = KEY, body = '{"data":{"id":"act_1"}}') => ({
  userId: USER,
  key,
  route: 'POST /v1/things',
  status: 201,
  body,
  ttl: 1_786_363_200,
  createdAt: CREATED_AT,
});

beforeAll(async () => {
  base = await import('../../src/repositories/base.js');
  idem = await import('../../src/repositories/idempotencyRepository.js');
  tx = await import('../../src/repositories/tx.js');
  cleanup = await import('../../src/services/idempotencyCleanupService.js');
});

describe('transaction-attached receipts', () => {
  it('survives a lost response and replays the original 201/body with one domain row', async () => {
    const builder = new tx.TransactionBuilder('crashFixture', 1)
      .add({ Put: { Item: { pk: 'TEST#domain', sk: 'META', writes: 1 } } })
      .addReserved(idem.receiptItem(receipt()));
    await tx.transactWrite(builder.build(), { operation: 'crashFixture' });

    const replay = await idem.loadReceipt(USER, KEY);
    expect(replay).toMatchObject({ status: 201, body: '{"data":{"id":"act_1"}}' });
    expect(await base.getItem({ pk: 'TEST#domain', sk: 'META' })).toMatchObject({
      writes: 1,
    });
  });

  it('allows exactly one same-key transaction to commit and stores no in-flight state', async () => {
    const run = async (suffix: string) => {
      const builder = new tx.TransactionBuilder(`race-${suffix}`, 1)
        .add({ Put: { Item: { pk: `TEST#race#${suffix}`, sk: 'META' } } })
        .addReserved(idem.receiptItem(receipt(KEY, `{"data":{"id":"${suffix}"}}`)));
      return tx.transactWrite(builder.build(), { operation: `race-${suffix}` });
    };

    const settled = await Promise.allSettled([run('a'), run('b')]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rows = await Promise.all([
      base.getItem({ pk: 'TEST#race#a', sk: 'META' }),
      base.getItem({ pk: 'TEST#race#b', sk: 'META' }),
    ]);
    expect(rows.filter(Boolean)).toHaveLength(1);
    const stored = await idem.loadReceipt(USER, KEY);
    expect(stored?.body).toMatch(/^\{"data":\{"id":"[ab]"\}\}$/);
    expect(stored?.status).toBe(201);
  });

  it('cancellation leaves neither domain data nor a success receipt', async () => {
    await base.putItem({
      pk: 'TEST#guard',
      sk: 'META',
      entity: 'Guard',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      schemaVersion: 1,
    });
    const key = '9f8e7d6c-8b86-d011-b42d-000000000002';
    const builder = new tx.TransactionBuilder('cancelFixture', 1)
      .add({
        Put: {
          Item: { pk: 'TEST#guard', sk: 'META' },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      })
      .addReserved(idem.receiptItem(receipt(key)));

    await expect(
      tx.transactWrite(builder.build(), { operation: 'cancelFixture' }),
    ).rejects.toBeDefined();
    expect(await idem.loadReceipt(USER, key)).toBeUndefined();
  });
});

describe('durable multi-phase cleanup', () => {
  const cleanupKey = '9f8e7d6c-8b86-d011-b42d-000000000003';
  const ref = { activityId: 'act_cleanup', userId: USER, idempotencyKey: cleanupKey };

  async function commitAbandonedWork() {
    const work = {
      ...ref,
      phases: [{ kind: 'delete_reminders' as const, complete: false }],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      schemaVersion: 1 as const,
    };
    const attachedReceipt = { ...receipt(cleanupKey), cleanupRef: ref };
    const builder = new tx.TransactionBuilder('cleanupFixture', 2)
      .add({
        Put: { Item: { pk: 'ACT#act_cleanup', sk: 'TEST#main', state: 'committed' } },
      })
      .addReserved(idem.receiptItem(attachedReceipt), idem.cleanupItem(work));
    await tx.transactWrite(builder.build(), { operation: 'cleanupFixture' });
  }

  it('commits receipt and work before a crash, then replay drains idempotently', async () => {
    await commitAbandonedWork();
    expect((await idem.loadReceipt(USER, cleanupKey))?.cleanupRef).toEqual(ref);
    expect(await idem.loadCleanup(ref)).toBeDefined();
    let effects = 0;
    const execute = async () => {
      effects += 1;
      return { complete: true };
    };

    await cleanup.drainCleanup(ref, execute, () => '2026-08-09T12:00:01.000Z');
    await cleanup.drainCleanup(ref, execute, () => '2026-08-09T12:00:02.000Z');

    expect(effects).toBe(1);
    expect(await idem.loadCleanup(ref)).toBeUndefined();
  });

  it('the next same-Activity mutation drains abandoned work', async () => {
    await commitAbandonedWork();
    let effects = 0;
    await cleanup.drainActivityCleanup(
      'act_cleanup',
      async () => {
        effects += 1;
        return { complete: true };
      },
      () => '2026-08-09T12:00:03.000Z',
    );

    expect(effects).toBe(1);
    expect(await idem.loadCleanup(ref)).toBeUndefined();
  });

  it('a cancelled main transaction stores neither receipt nor cleanup work', async () => {
    const key = '9f8e7d6c-8b86-d011-b42d-000000000004';
    const cancelledRef = {
      activityId: 'act_cancelled',
      userId: USER,
      idempotencyKey: key,
    };
    await base.putItem({
      pk: 'ACT#act_cancelled',
      sk: 'TEST#guard',
      entity: 'Guard',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      schemaVersion: 1,
    });
    const work = {
      ...cancelledRef,
      phases: [{ kind: 'reset_rsvp' as const, complete: false }],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      schemaVersion: 1 as const,
    };
    const builder = new tx.TransactionBuilder('cancelCleanupFixture', 2)
      .add({
        Put: {
          Item: { pk: 'ACT#act_cancelled', sk: 'TEST#guard' },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      })
      .addReserved(
        idem.receiptItem({ ...receipt(key), cleanupRef: cancelledRef }),
        idem.cleanupItem(work),
      );

    await expect(
      tx.transactWrite(builder.build(), { operation: 'cancelCleanupFixture' }),
    ).rejects.toBeDefined();
    expect(await idem.loadReceipt(USER, key)).toBeUndefined();
    expect(await idem.loadCleanup(cancelledRef)).toBeUndefined();
  });
});
