import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useNotesDraft } from './useNotesDraft';

it('keeps notes as a draft until one explicit save succeeds', async () => {
  let finish: (success: boolean) => void = () => {};
  const save = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useNotesDraft('', save));
  act(() => result.current.edit());
  act(() => result.current.change('Bring dessert'));
  expect(save).not.toHaveBeenCalled();
  let pending: Promise<void>;
  act(() => {
    pending = result.current.save();
  });
  expect(result.current.saving).toBe(true);
  await act(() => result.current.save());
  expect(save).toHaveBeenCalledExactlyOnceWith('Bring dessert');
  expect(result.current.draft).toBe('Bring dessert');
  await act(async () => {
    finish(true);
    await pending;
  });
  expect(result.current.editing).toBe(false);
});

it('retains a failed draft for retry, including after the server value refreshes', async () => {
  const save = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(true);
  const { result, rerender } = renderHook(({ value }) => useNotesDraft(value, save), {
    initialProps: { value: 'Original' },
  });
  act(() => result.current.edit());
  act(() => result.current.change('My draft'));
  rerender({ value: 'Refetched notes' });
  await act(() => result.current.save());
  expect(result.current.error).toBe(true);
  expect(result.current.draft).toBe('My draft');
  await act(() => result.current.save());
  expect(result.current.editing).toBe(true);
  await act(() => result.current.save());
  expect(result.current.editing).toBe(false);
  expect(save.mock.calls).toEqual([['My draft'], ['My draft'], ['My draft']]);
});

it('cancels unchanged notes immediately and confirms changed drafts before leaving', () => {
  const leave = vi.fn();
  const save = vi.fn();
  const { result } = renderHook(() => useNotesDraft('Original', save));
  act(() => result.current.edit());
  act(() => result.current.cancel());
  expect(result.current.editing).toBe(false);
  act(() => result.current.edit());
  act(() => result.current.change('Changed'));
  act(() => result.current.requestLeave(leave));
  expect(leave).not.toHaveBeenCalled();
  expect(result.current.confirming).toBe(true);
  act(() => result.current.keepEditing());
  expect(result.current.draft).toBe('Changed');
  act(() => result.current.requestLeave(leave));
  act(() => result.current.discard());
  expect(leave).toHaveBeenCalledOnce();
  expect(result.current.editing).toBe(false);
  expect(save).not.toHaveBeenCalled();
});
