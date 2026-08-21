import { describe, expect, it } from 'vitest';
import {
  LegacyIntentLog,
  LegacyIntentLogInvariantError,
  type LegacyIntentLogStorage,
  LegacyIntentLogUnsupportedError,
  legacyIntentLogKey,
  parseLegacyIntentEnvelope,
} from '@/lib/legacyIntentLog';

const OWNER = 'usr_01J0000000000000000000000A';
const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function memoryStorage(seed: Record<string, string> = {}): {
  readonly storage: LegacyIntentLogStorage;
  readonly values: Map<string, string>;
} {
  const values = new Map(Object.entries(seed));
  return {
    values,
    storage: {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        values.set(key, value);
      },
      removeItem: async (key) => {
        values.delete(key);
      },
    },
  };
}

function input(intentId = 'legacy-one') {
  return {
    intentId,
    mutationKey: ['activity', 'complete'],
    variables: { activityId: 'act_one', idempotencyKey: intentId },
    entityId: 'act_one',
  };
}

describe('migration-only legacy intent envelope', () => {
  it('normalizes v1 attention, sequence, ownership, and conflicting duplicate ids', () => {
    const parsed = parseLegacyIntentEnvelope(
      {
        schemaVersion: 1,
        ownerUserId: 'wrong-owner',
        intents: [
          { ...input(), status: 'failed', createdAt: NOW - 1_000 },
          { ...input(), status: 'failed', createdAt: NOW - 1_000 },
          {
            ...input(),
            variables: { activityId: 'act_one', idempotencyKey: 'different' },
            status: 'needs_confirmation',
            createdAt: NOW - 500,
          },
        ],
      },
      OWNER,
      NOW,
    );

    expect(parsed.ownerUserId).toBe(OWNER);
    expect(parsed.intents).toHaveLength(2);
    expect(parsed.intents[0]).toMatchObject({
      intentId: 'legacy-one',
      seq: 1,
      status: 'needs_attention',
      attention: { kind: 'rejected' },
    });
    expect(parsed.intents[1]).toMatchObject({
      intentId: 'legacy-one~legacy-2',
      seq: 3,
      status: 'needs_attention',
      attention: { kind: 'parked', reason: 'legacy_unknown' },
    });
  });

  it('surfaces a newer schema instead of discarding unknown accepted work', () => {
    expect(() =>
      parseLegacyIntentEnvelope({ schemaVersion: 99, intents: [] }, OWNER, NOW),
    ).toThrow(LegacyIntentLogUnsupportedError);
  });

  it('requeues an interrupted claim and preserves age/clock evidence on hydrate', async () => {
    const key = legacyIntentLogKey(OWNER);
    const { storage, values } = memoryStorage({
      [key]: JSON.stringify({
        schemaVersion: 2,
        ownerUserId: OWNER,
        clockWitness: NOW,
        nextSeq: 2,
        intents: [
          {
            ...input(),
            ownerUserId: OWNER,
            status: 'in_flight',
            createdAt: NOW - 1_000,
            seq: 1,
            attempts: 1,
          },
        ],
      }),
    });
    const legacy = new LegacyIntentLog(OWNER, storage, () => NOW);

    await legacy.hydrate();

    expect(legacy.snapshot().intents[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
    });
    expect(JSON.parse(values.get(key) ?? '{}').intents[0]).toMatchObject({
      status: 'queued',
      attempts: 1,
    });
  });

  it('merges paused mutations idempotently and survives a restart', async () => {
    const { storage } = memoryStorage();
    const first = new LegacyIntentLog(OWNER, storage, () => NOW);
    await first.hydrate();
    await first.appendMigrated(input(), { createdAt: NOW - 2_000, attempts: 3 });
    await first.appendMigrated(input(), { createdAt: NOW - 2_000, attempts: 3 });

    const relaunched = new LegacyIntentLog(OWNER, storage, () => NOW);
    await relaunched.hydrate();

    expect(relaunched.pending()).toEqual([
      expect.objectContaining({
        intentId: 'legacy-one',
        createdAt: NOW - 2_000,
        attempts: 3,
      }),
    ]);
    await expect(
      relaunched.appendMigrated({ ...input(), entityId: 'act_other' }),
    ).rejects.toThrow(LegacyIntentLogInvariantError);
  });

  it('purges only the owner-scoped legacy key after verified import', async () => {
    const otherKey = legacyIntentLogKey('usr_other');
    const { storage, values } = memoryStorage({ [otherKey]: '{"intents":[]}' });
    const legacy = new LegacyIntentLog(OWNER, storage, () => NOW);
    await legacy.appendMigrated(input());

    await legacy.purge();

    expect(values.has(legacyIntentLogKey(OWNER))).toBe(false);
    expect(values.has(otherKey)).toBe(true);
  });
});
