import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToast } from '@/stores/toast';
import { useActivityActions } from './useActivityActions.native';

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  uuid: vi.fn(),
  presentFollowUp: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('@/hooks/useClock', () => ({
  useClock: () => ({ now: () => '2026-08-19T12:00:00.000Z' }),
}));
vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => mocks.state,
}));
vi.mock('@/hooks/useFollowUp', () => ({
  useFollowUpActions: () => ({ present: mocks.presentFollowUp }),
}));

const ACTIVITY = 'act_01J0000000000000000000000A';

beforeEach(() => {
  mocks.uuid.mockReset();
  mocks.uuid.mockReturnValue('undo-intent');
  mocks.presentFollowUp.mockReset();
  useToast.setState({ current: undefined });
});

describe('native useActivityActions restoration state', () => {
  it('absorbs a rejected authorization read and retries the same skip intent', async () => {
    const read = vi.fn().mockRejectedValue(new Error('sqlite implementation detail'));
    mocks.state = {
      activities: { read },
      coordinator: { skip: vi.fn() },
    };
    const mounted = renderHook(() => useActivityActions(ACTIVITY));

    await act(async () =>
      expect(await mounted.result.current.skip({ kind: 'activity' })).toBe(false),
    );
    expect(mounted.result.current.errorMessage).toBe("Couldn't do that.");
    expect(mounted.result.current.isBusy).toBe(false);

    act(() => mounted.result.current.retryError());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(mocks.uuid).toHaveBeenCalledTimes(1);
  });

  it('absorbs a rejected child restoration read and leaves the hook idle', async () => {
    mocks.state = {
      activities: {
        readChildRestoredStatus: vi
          .fn()
          .mockRejectedValue(new Error('sqlite implementation detail')),
      },
      coordinator: { complete: vi.fn() },
    };
    const mounted = renderHook(() => useActivityActions(ACTIVITY));

    await act(async () =>
      expect(
        await mounted.result.current.setChildCompletion(
          {
            activityId: 'act_01J0000000000000000000000B',
            title: 'Pack a bag',
            status: 'saved',
            restoredStatus: 'saved',
            isRecurring: false,
          },
          true,
        ),
      ).toBe(false),
    );
    expect(mounted.result.current.errorMessage).toBe("Couldn't do that.");
    expect(mounted.result.current.isBusy).toBe(false);
  });

  it('catches a rejected toast undo and always clears the undoing state', async () => {
    const complete = vi.fn().mockResolvedValue({
      kind: 'accepted',
      status: 'queued',
      intent: {},
      commitRevision: 1,
    });
    mocks.state = {
      activities: {
        read: vi.fn().mockResolvedValue({
          activity: { activityId: ACTIVITY, status: 'saved' },
        }),
      },
      coordinator: {
        complete,
        undoCompletion: vi
          .fn()
          .mockRejectedValue(new Error('sqlite implementation detail')),
      },
    };
    const projected = vi.fn();
    const mounted = renderHook(() => useActivityActions(ACTIVITY));

    act(() =>
      mounted.result.current.resolvePassed('done', { kind: 'activity' }, projected),
    );
    await waitFor(() => expect(projected).toHaveBeenCalledWith(true));
    act(() => useToast.getState().undo());

    await waitFor(() =>
      expect(mounted.result.current.errorMessage).toBe("Couldn't do that."),
    );
    expect(mounted.result.current.isUndoing).toBe(false);
  });

  it.each([
    ['an undated Plan', undefined, 'saved'],
    ['a dated Plan', { date: '2026-08-20', timezone: 'America/New_York' }, 'scheduled'],
  ] as const)(
    'restores %s from its durable schedule',
    async (_label, schedule, expected) => {
      const complete = vi.fn().mockResolvedValue({
        kind: 'accepted',
        status: 'queued',
        intent: {},
        commitRevision: 1,
      });
      mocks.state = {
        activities: {
          read: vi.fn().mockResolvedValue({
            activity: {
              activityId: ACTIVITY,
              status: 'completed',
              ...(schedule === undefined ? {} : { schedule }),
            },
          }),
        },
        coordinator: { complete },
      };
      const onProjected = vi.fn();
      const mounted = renderHook(() => useActivityActions(ACTIVITY));

      act(() => mounted.result.current.undoResolution({ kind: 'activity' }, onProjected));
      await waitFor(() => expect(onProjected).toHaveBeenCalledWith(false));
      expect(complete).toHaveBeenCalledWith(
        ACTIVITY,
        'undo-intent',
        {},
        false,
        expected,
        expect.objectContaining({ today: '2026-08-19' }),
      );
    },
  );

  it('attaches the server follow-up to the completion Undo toast', async () => {
    const { emitCompletionFollowUp } = await import('@/lib/completionFollowUp');
    const complete = vi.fn().mockImplementation(async () => {
      emitCompletionFollowUp('undo-intent', {
        followUp: { kind: 'open_prep', count: 1, childIds: ['act_prep'] },
      });
      return { kind: 'accepted', status: 'queued', intent: {}, commitRevision: 1 };
    });
    mocks.state = {
      activities: {
        read: vi.fn().mockResolvedValue({
          activity: { activityId: ACTIVITY, status: 'saved' },
        }),
      },
      coordinator: { complete },
    };
    const projected = vi.fn();
    const mounted = renderHook(() => useActivityActions(ACTIVITY));

    act(() =>
      mounted.result.current.resolvePassed('done', { kind: 'activity' }, projected),
    );
    await waitFor(() => expect(projected).toHaveBeenCalledWith(true));
    await waitFor(() => expect(mocks.presentFollowUp).toHaveBeenCalledTimes(1));
    expect(mocks.presentFollowUp).toHaveBeenCalledWith(
      { followUp: { kind: 'open_prep', count: 1, childIds: ['act_prep'] } },
      { activityId: ACTIVITY, activityType: undefined },
      expect.any(Number),
    );
    expect(useToast.getState().current).toMatchObject({ kind: 'undo' });
  });
});
