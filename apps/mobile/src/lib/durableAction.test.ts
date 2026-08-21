import { describe, expect, it, vi } from 'vitest';
import { coordinateDurableAction } from '@/lib/durableAction';

const ENTITY = 'act_01J0000000000000000000000B';

function descriptor(intentId = 'original') {
  return {
    intentId,
    mutationKey: ['activity', 'complete'],
    variables: { activityId: ENTITY, idempotencyKey: intentId },
    entityId: ENTITY,
  };
}

describe('online-first web action coordinator', () => {
  it('projects immediately, then acknowledges a completed request', async () => {
    const apply = vi.fn();
    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply,
      revert: vi.fn(),
      rollback: vi.fn(),
      dispatch: vi.fn(async () => undefined),
    });

    expect(apply).toHaveBeenCalledOnce();
    expect(await action.attempt).toMatchObject({ status: 'acknowledged' });
  });

  it('rolls back and refuses a transient web request failure', async () => {
    const rollback = vi.fn();
    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply: vi.fn(),
      revert: vi.fn(),
      rollback,
      dispatch: vi.fn(async () => {
        throw new Error('offline');
      }),
    });

    expect(await action.attempt).toMatchObject({
      status: 'refused',
      lastError: 'offline',
    });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('reports permanent rejection structurally and rolls back', async () => {
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

  it('dispatches the inverse after an acknowledged action is undone', async () => {
    const revert = vi.fn();
    const inverseDispatch = vi.fn(async () => undefined);
    const action = await coordinateDurableAction({
      intent: descriptor(),
      apply: vi.fn(),
      revert,
      rollback: vi.fn(),
      dispatch: vi.fn(async () => undefined),
      inverse: { intent: descriptor('inverse'), dispatch: inverseDispatch },
    });
    await action.attempt;

    const inverse = await action.undo();

    expect(revert).toHaveBeenCalledOnce();
    expect(await inverse.attempt).toMatchObject({ status: 'acknowledged' });
    expect(inverseDispatch).toHaveBeenCalledOnce();
  });
});
