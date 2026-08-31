import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useLongPressActivation } from './useLongPressActivation';

describe('the long-press activation guard', () => {
  it('consumes the synthetic press belonging to the long-press gesture', () => {
    const onActivate = vi.fn();
    const { result } = renderHook(() => useLongPressActivation(onActivate));

    act(result.current.markLongPress);
    act(result.current.activate);

    expect(onActivate).not.toHaveBeenCalled();
  });

  it('opens on the first tap after the actions sheet is dismissed', () => {
    const onActivate = vi.fn();
    const { result } = renderHook(() => useLongPressActivation(onActivate));

    act(result.current.markLongPress);
    act(result.current.dismissActions);
    act(result.current.activate);

    expect(onActivate).toHaveBeenCalledOnce();
  });
});
