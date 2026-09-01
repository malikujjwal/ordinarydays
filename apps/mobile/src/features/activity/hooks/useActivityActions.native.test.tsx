import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivityActions } from './useActivityActions.native';

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  uuid: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: mocks.uuid }));
vi.mock('@/hooks/useClock', () => ({
  useClock: () => ({ now: () => '2026-08-19T12:00:00.000Z' }),
}));
vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => mocks.state,
}));

const ACTIVITY = 'act_01J0000000000000000000000A';

beforeEach(() => {
  mocks.uuid.mockReset();
  mocks.uuid.mockReturnValue('undo-intent');
});

describe('native useActivityActions restoration state', () => {
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
});
