import { afterEach, describe, expect, it, vi } from 'vitest';
import { coordinateDurableAction } from '@/lib/durableAction';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import { setActiveIntentLog } from '@/lib/intentReplay';

const USER = 'usr_01J0000000000000000000000A';
const ENTITY = 'act_01J0000000000000000000000B';

function storage(): IntentLogStorage & { fail: boolean } {
  const data = new Map<string, string>();
  const result: IntentLogStorage & { fail: boolean } = {
    fail: false,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      if (result.fail) throw new Error('disk full');
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return result;
}

function descriptor(intentId = 'original') {
  return {
    intentId,
    mutationKey: ['activity', 'complete'],
    variables: { activityId: ENTITY, idempotencyKey: intentId },
    entityId: ENTITY,
  };
}

afterEach(() => setActiveIntentLog(undefined));

describe('durable action coordinator', () => {
  it('returns refused, sends nothing and rolls back when append fails', async () => {
    const backing = storage();
    const log = new IntentLog(USER, backing);
    await log.hydrate();
    backing.fail = true;
    setActiveIntentLog(log);
    const request = vi.fn(async () => undefined);
    const rollback = vi.fn();

    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply: vi.fn(),
      revert: vi.fn(),
      rollback,
      dispatch: request,
    });

    expect(action.snapshot().status).toBe('refused');
    expect((await action.attempt).status).toBe('refused');
    expect(request).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('keeps a transient offline completion projected and queued', async () => {
    const backing = storage();
    const log = new IntentLog(USER, backing);
    await log.hydrate();
    setActiveIntentLog(log);
    const apply = vi.fn();
    const rollback = vi.fn();

    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply,
      revert: vi.fn(),
      rollback,
      dispatch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    expect((await action.attempt).status).toBe('queued');
    expect(apply).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(log.snapshot().intents[0]).toMatchObject({
      status: 'queued',
      lastError: 'offline',
    });
  });

  it('reports permanent rejection structurally and rolls back', async () => {
    const backing = storage();
    const log = new IntentLog(USER, backing);
    await log.hydrate();
    setActiveIntentLog(log);
    const rollback = vi.fn();

    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply: vi.fn(),
      revert: vi.fn(),
      rollback,
      dispatch: vi.fn(async () => {
        throw Object.assign(new Error('invalid'), {
          status: 422,
          code: 'validation_failed',
          details: [{ path: 'status' }],
        });
      }),
    });

    expect(await action.attempt).toMatchObject({
      status: 'needs_attention',
      attention: {
        kind: 'rejected',
        status: 422,
        code: 'validation_failed',
      },
    });
    expect(rollback).toHaveBeenCalledOnce();
  });
});
