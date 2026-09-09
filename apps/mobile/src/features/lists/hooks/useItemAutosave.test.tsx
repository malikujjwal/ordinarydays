import type { PatchListItemInput } from '@od/shared/client';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { notePatch, titlePatch } from '../model/itemSheet';
import { useItemAutosave } from './useItemAutosave';

const original: ListItemRow = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  rank: 'a0',
  title: 'Original',
  state: 'open',
};
function deferred() {
  let resolve: (value: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('item field persistence acknowledgement', () => {
  it.each(['title', 'note'] as const)(
    'coalesces %s edits while a write is in flight and retains the latest after failure',
    async (key) => {
      const first = deferred();
      const save = vi
        .fn<(item: ListItemRow, patch: PatchListItemInput) => Promise<boolean>>()
        .mockReturnValueOnce(first.promise)
        .mockResolvedValue(true);
      const { result } = renderHook(() => useItemAutosave(original, save));
      const makePatch = key === 'title' ? titlePatch : notePatch;
      await act(async () =>
        result.current.field(key).now((row) => makePatch(row, 'First')),
      );
      act(() => result.current.field(key).schedule((row) => makePatch(row, 'Second')));
      act(() => result.current.field(key).schedule((row) => makePatch(row, 'Latest')));
      await act(async () => vi.advanceTimersByTime(350));
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => first.resolve(false));
      expect(result.current.status).toBe('failed');
      await act(async () => vi.advanceTimersByTime(3500));
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => {
        result.current.retry();
        result.current.retry();
      });
      expect(save).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenLastCalledWith(original, { [key]: 'Latest' });
      expect(result.current.status).toBe('saved');
    },
  );

  it('keeps independent pending fields saving until both acknowledge', async () => {
    const title = deferred();
    const note = deferred();
    const save = vi
      .fn()
      .mockReturnValueOnce(title.promise)
      .mockReturnValueOnce(note.promise);
    const { result } = renderHook(() => useItemAutosave(original, save));
    act(() => {
      result.current.field('title').now((row) => titlePatch(row, 'New'));
      result.current.field('note').now((row) => notePatch(row, 'Note'));
    });
    await act(async () => title.resolve(true));
    expect(result.current.status).toBe('saving');
    await act(async () => note.resolve(true));
    expect(result.current.status).toBe('saved');
  });

  it('does not let a lagging refresh cancel a return to the prior value', async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const { result, rerender } = renderHook(({ row }) => useItemAutosave(row, save), {
      initialProps: { row: original },
    });
    await act(async () =>
      result.current.field('title').now((row) => titlePatch(row, 'Changed')),
    );
    await act(async () =>
      result.current.field('title').now((row) => titlePatch(row, 'Original')),
    );
    rerender({ row: { ...original, note: 'Incoming refresh' } });
    await act(async () => first.resolve(true));
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Changed', note: 'Incoming refresh' }),
      { title: 'Original' },
    );
  });

  it.each([true, false])(
    'keeps an invalid replacement invalid when the earlier write settles: %s',
    async (accepted) => {
      const first = deferred();
      const { result } = renderHook(() => useItemAutosave(original, () => first.promise));
      await act(async () =>
        result.current.field('title').now((row) => titlePatch(row, 'Changed')),
      );
      act(() => result.current.field('title').invalid());
      await act(async () => first.resolve(accepted));
      expect(result.current.status).toBe('invalid');
      await act(async () => result.current.retry());
      expect(result.current.status).toBe('invalid');
    },
  );

  it('continues flushed queued writes after dismissal unmounts the editor', async () => {
    const first = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
    const { result, unmount } = renderHook(() => useItemAutosave(original, save));
    await act(async () =>
      result.current.field('title').now((row) => titlePatch(row, 'First')),
    );
    act(() => result.current.field('title').schedule((row) => titlePatch(row, 'Last')));
    act(() => result.current.field('title').flush());
    unmount();
    await act(async () => first.resolve(true));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'First' }), {
      title: 'Last',
    });
  });
});

it('keeps the latest failed draft reachable through the retry callback after close', async () => {
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
  const { result, unmount } = renderHook(() => useItemAutosave(original, save));
  const retryAfterClose = result.current.retry;
  await act(async () =>
    result.current.field('title').now((row) => titlePatch(row, 'First')),
  );
  await act(async () =>
    result.current.field('title').now((row) => titlePatch(row, 'Latest')),
  );
  unmount();
  await act(async () => first.resolve(false));
  await act(async () => retryAfterClose());
  expect(save).toHaveBeenLastCalledWith(original, { title: 'Latest' });
});

it('orders a reopened editor after the in-flight write and supersedes the dismissed queued draft', async () => {
  const first = deferred();
  const writes: string[] = [];
  const save = vi.fn(async (_row: ListItemRow, patch: PatchListItemInput) => {
    if (patch.title === 'First') await first.promise;
    writes.push(patch.title ?? '');
    return true;
  });
  const old = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    old.result.current.field('title').now((row) => titlePatch(row, 'First')),
  );
  act(() =>
    old.result.current.field('title').now((row) => titlePatch(row, 'Dismissed draft')),
  );
  old.unmount();
  const reopened = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    reopened.result.current
      .field('title')
      .now((row) => titlePatch(row, 'Newest session')),
  );
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => first.resolve(true));
  expect(writes).toEqual(['First', 'Newest session']);
  expect(reopened.result.current.status).toBe('saved');
});

it('writes the requested value after reopening even when the projection still holds that old value', async () => {
  const save = vi.fn().mockResolvedValue(true);
  const old = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    old.result.current.field('title').now((row) => titlePatch(row, 'Changed', true)),
  );
  old.unmount();
  const reopened = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    reopened.result.current
      .field('title')
      .now((row) => titlePatch(row, 'Original', true)),
  );
  expect(save).toHaveBeenLastCalledWith(original, { title: 'Original' });
  expect(save).toHaveBeenCalledTimes(2);
});

it('retires an abandoned failed reservation when another editor makes a newer edit', async () => {
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const old = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    old.result.current.field('title').now((row) => titlePatch(row, 'Failed', true)),
  );
  const oldRetry = old.result.current.retry;
  old.unmount();
  const next = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    next.result.current.field('title').now((row) => titlePatch(row, 'New', true)),
  );
  await act(async () => oldRetry());
  expect(save).toHaveBeenCalledTimes(2);
  next.unmount();
  const refreshed = renderHook(() =>
    useItemAutosave({ ...original, title: 'Remote' }, save),
  );
  await act(async () =>
    refreshed.result.current.field('title').now((row) => titlePatch(row, 'New', true)),
  );
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Remote' }), {
    title: 'New',
  });
});

it('prevents an older in-flight failure from retrying over a newer editing session', async () => {
  const first = deferred();
  const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(true);
  const old = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    old.result.current.field('title').now((row) => titlePatch(row, 'Old', true)),
  );
  const staleRetry = old.result.current.retry;
  old.unmount();
  const current = renderHook(() => useItemAutosave(original, save));
  await act(async () =>
    current.result.current.field('title').now((row) => titlePatch(row, 'Newest', true)),
  );
  await act(async () => first.resolve(false));
  await act(async () => staleRetry());
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith(original, { title: 'Newest' });
});
