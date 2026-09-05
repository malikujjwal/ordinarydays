import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { PlansView } from './usePlans';
import { usePlansBoundaryNavigation } from './usePlansBoundaryNavigation';

const boundary = { from: '2026-10-07', to: '2027-08-31' };

it('suppresses calendar viewability, then loads one bounded page when the user approaches the gap', async () => {
  let complete = () => {};
  const loadRange = vi.fn<PlansView['loadRange']>(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const { result } = renderHook(() => usePlansBoundaryNavigation(loadRange));
  act(() => {
    result.current.selectDate();
    result.current.visible(boundary);
  });
  expect(loadRange).not.toHaveBeenCalled();
  act(() => result.current.beginScroll());
  expect(loadRange).toHaveBeenCalledExactlyOnceWith(
    'upcoming',
    {
      from: '2026-10-07',
      through: '2026-12-07',
    },
    expect.any(AbortSignal),
  );
  expect(result.current.pending).toBe(boundary.from);
  act(() => {
    result.current.visible(boundary);
    result.current.load(boundary);
  });
  expect(loadRange).toHaveBeenCalledTimes(1);
  await act(async () => complete());
  expect(result.current.pending).toBeUndefined();
  act(() => {
    result.current.selectDate();
    result.current.visible({ from: '2026-12-08', to: boundary.to });
  });
  expect(loadRange).toHaveBeenCalledTimes(1);
});

it('keeps failure on its range, refuses automatic retries, and retries explicitly with the same bounds', async () => {
  const loadRange = vi
    .fn<PlansView['loadRange']>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(undefined);
  const { result } = renderHook(() => usePlansBoundaryNavigation(loadRange));
  act(() => {
    result.current.visible(boundary);
    result.current.beginScroll();
  });
  await waitFor(() => expect(result.current.failed).toBe(boundary.from));
  expect(result.current.pending).toBeUndefined();
  act(() => {
    result.current.visible(boundary);
    result.current.beginScroll();
  });
  expect(loadRange).toHaveBeenCalledTimes(1);
  await act(async () => result.current.load(boundary));
  expect(loadRange).toHaveBeenCalledTimes(2);
  expect(loadRange.mock.calls[1]?.slice(0, 2)).toEqual(
    loadRange.mock.calls[0]?.slice(0, 2),
  );
  expect(result.current.failed).toBeUndefined();
  expect(result.current.pending).toBeUndefined();
});

it('aborts an outstanding range when the screen unmounts', () => {
  const loadRange = vi.fn<PlansView['loadRange']>(() => new Promise<void>(() => {}));
  const { result, unmount } = renderHook(() => usePlansBoundaryNavigation(loadRange));
  act(() => result.current.load(boundary));
  const signal = loadRange.mock.calls[0]?.[2];
  unmount();
  expect(signal?.aborted).toBe(true);
});
