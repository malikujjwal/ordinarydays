import type { ActivityUpdate, PostActivityUpdateResult } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerActivityMutationDefaults } from '@/lib/mutationDefaults';
import { activityKey } from '@/lib/queryKeys';
import { useActivityUpdates } from './useActivityUpdates';

const clients = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  remove: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('@od/shared/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@od/shared/client')>()),
  getActivityUpdates: clients.get,
  postActivityUpdate: clients.post,
  deleteActivityUpdate: clients.remove,
}));
vi.mock('expo-crypto', () => ({ randomUUID: clients.uuid }));

const ACTIVITY = 'act_01J0000000000000000000000A';
const OTHER = 'act_01J0000000000000000000000B';

function update(index: number, activityId = ACTIVITY): ActivityUpdate {
  return {
    updateId: `upd_01J0000000000000000000P${50 + index}`,
    activityId,
    kind: 'user',
    authorUserId: 'usr_01J0000000000000000000000B',
    body: `Note ${index}`,
    createdAt: `2026-08-1${index}T10:00:00.000Z`,
    schemaVersion: 1,
  };
}

function posted(entry: ActivityUpdate): PostActivityUpdateResult {
  return { update: entry, lastActivityAt: entry.createdAt };
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function queryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  registerActivityMutationDefaults(client, {} as never);
  return client;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

type Embedded = {
  updates: readonly ActivityUpdate[] | undefined;
  cursor: string | undefined;
};

function render(client: QueryClient, initial: Embedded & { activityId?: string }) {
  return renderHook(
    (props: Embedded & { activityId?: string }) =>
      useActivityUpdates(props.activityId ?? ACTIVITY, {
        updates: props.updates,
        cursor: props.cursor,
      }),
    { wrapper: wrapper(client), initialProps: initial },
  );
}

const bodies = (entries: readonly ActivityUpdate[]) => entries.map((entry) => entry.body);

beforeEach(() => {
  clients.get.mockReset();
  clients.post.mockReset();
  clients.remove.mockReset();
  clients.uuid.mockReset();
});

describe('useActivityUpdates (web)', () => {
  it('seeds newest-first from the embedded page and pages older entries through the cursor', async () => {
    clients.get.mockResolvedValueOnce({ updates: [update(2)], cursor: undefined });
    const { result } = render(queryClient(), {
      updates: [update(1), update(3)],
      cursor: 'cur_1',
    });
    expect(bodies(result.current.updates)).toEqual(['Note 3', 'Note 1']);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.cursor).toBeUndefined());

    expect(clients.get).toHaveBeenCalledWith(expect.anything(), ACTIVITY, 'cur_1');
    expect(bodies(result.current.updates)).toEqual(['Note 3', 'Note 2', 'Note 1']);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it('keeps the failed cursor for an action-specific retry', async () => {
    clients.get
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ updates: [update(1)], cursor: undefined });
    const { result } = render(queryClient(), { updates: [update(2)], cursor: 'cur_1' });

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.errorAction).toBe('load'));
    expect(result.current.cursor).toBe('cur_1');

    await expect(act(() => result.current.retryFailure())).resolves.toBe(true);
    expect(clients.get).toHaveBeenLastCalledWith(expect.anything(), ACTIVITY, 'cur_1');
    await waitFor(() => expect(result.current.errorAction).toBeUndefined());
    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);
  });

  it('shows a pending row, then the response row, and invalidates the detail query', async () => {
    const client = queryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const response = deferred<PostActivityUpdateResult>();
    clients.post.mockReturnValueOnce(response.promise);
    clients.uuid.mockReturnValueOnce('local-1').mockReturnValueOnce('idem-1');
    const { result } = render(client, { updates: [update(1)], cursor: undefined });

    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = result.current.post('  Note 2  ');
    });
    await waitFor(() =>
      expect(result.current.pending).toEqual([{ localId: 'local-1', body: 'Note 2' }]),
    );
    expect(result.current.isPosting).toBe(true);

    response.resolve(posted(update(2)));
    await expect(outcome).resolves.toBe(true);
    await waitFor(() => expect(result.current.pending).toEqual([]));

    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);
    expect(clients.post).toHaveBeenCalledWith(
      expect.anything(),
      ACTIVITY,
      'Note 2',
      'idem-1',
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: activityKey(ACTIVITY) });
  });

  it('keeps the response row across a stale head and retires it once a head contains it', async () => {
    clients.post.mockResolvedValueOnce(posted(update(2)));
    clients.uuid.mockReturnValue('id');
    const { result, rerender } = render(queryClient(), {
      updates: [update(1)],
      cursor: undefined,
    });
    await expect(act(() => result.current.post('Note 2'))).resolves.toBe(true);
    await waitFor(() =>
      expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']),
    );

    // An older in-flight detail response lands without the post: nothing disappears.
    rerender({ updates: [update(1)], cursor: undefined });
    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);

    // The strong refetch contains it: the head owns the row and nothing duplicates.
    rerender({ updates: [update(2), update(1)], cursor: undefined });
    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);
  });

  it('rolls back a failed post and reuses its idempotency key on retry', async () => {
    clients.post
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(posted(update(2)));
    clients.uuid.mockReturnValueOnce('local-1').mockReturnValueOnce('idem-1');
    const { result } = render(queryClient(), { updates: [update(1)], cursor: undefined });

    await expect(act(() => result.current.post('Note 2'))).resolves.toBe(false);
    await waitFor(() => expect(result.current.errorAction).toBe('post'));
    expect(result.current.pending).toEqual([]);
    expect(bodies(result.current.updates)).toEqual(['Note 1']);

    await expect(act(() => result.current.retryFailure())).resolves.toBe(true);
    expect(clients.post).toHaveBeenLastCalledWith(
      expect.anything(),
      ACTIVITY,
      'Note 2',
      'idem-1',
    );
    await waitFor(() => expect(result.current.errorAction).toBeUndefined());
    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);
  });

  it('hides a deleted entry at once, restores it when the delete fails, and retries', async () => {
    const client = queryClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const failure = deferred<never>();
    clients.remove
      .mockReturnValueOnce(failure.promise)
      .mockResolvedValueOnce({ updateId: update(1).updateId });
    const { result } = render(client, {
      updates: [update(1), update(2)],
      cursor: undefined,
    });

    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = result.current.remove(update(1));
    });
    await waitFor(() => expect(bodies(result.current.updates)).toEqual(['Note 2']));

    failure.reject(new Error('nope'));
    await expect(outcome).resolves.toBe(false);
    await waitFor(() => expect(result.current.errorAction).toBe('delete'));
    expect(bodies(result.current.updates)).toEqual(['Note 2', 'Note 1']);

    await expect(act(() => result.current.retryFailure())).resolves.toBe(true);
    await waitFor(() => expect(bodies(result.current.updates)).toEqual(['Note 2']));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: activityKey(ACTIVITY) });
  });

  it('never deletes a system entry', async () => {
    const { result } = render(queryClient(), {
      updates: [{ ...update(1), kind: 'system', authorUserId: undefined }],
      cursor: undefined,
    });
    const system = result.current.updates[0];
    if (system === undefined) throw new Error('missing system entry');
    await expect(act(() => result.current.remove(system))).resolves.toBe(false);
    expect(clients.remove).not.toHaveBeenCalled();
  });

  it('resets every piece of feed state when the activity changes', async () => {
    clients.get.mockResolvedValueOnce({ updates: [update(2)], cursor: undefined });
    const { result, rerender } = render(queryClient(), {
      updates: [update(3)],
      cursor: 'cur_1',
    });
    act(() => result.current.loadMore());
    await waitFor(() =>
      expect(bodies(result.current.updates)).toEqual(['Note 3', 'Note 2']),
    );

    rerender({ activityId: OTHER, updates: [update(4, OTHER)], cursor: 'cur_other' });

    expect(bodies(result.current.updates)).toEqual(['Note 4']);
    expect(result.current.cursor).toBe('cur_other');
    expect(result.current.pending).toEqual([]);
    expect(result.current.errorAction).toBeUndefined();
  });

  it('drops a continuation page that resolves after a newer head was installed', async () => {
    const page = deferred<{ updates: ActivityUpdate[]; cursor: string | undefined }>();
    clients.get.mockReturnValueOnce(page.promise);
    const { result, rerender } = render(queryClient(), {
      updates: [update(3)],
      cursor: 'cur_1',
    });
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.isLoadingMore).toBe(true));

    // A strong detail refetch lands first: update 3 was deleted remotely, the chain restarts.
    rerender({ updates: [update(4)], cursor: 'cur_2' });
    page.resolve({ updates: [update(2), update(3)], cursor: 'cur_stale' });
    await waitFor(() => expect(result.current.isLoadingMore).toBe(false));

    expect(bodies(result.current.updates)).toEqual(['Note 4']);
    expect(result.current.cursor).toBe('cur_2');
  });

  it('treats an absent embedded page as one stable empty head', () => {
    const { result, rerender } = render(queryClient(), {
      updates: undefined,
      cursor: undefined,
    });
    const first = result.current.updates;
    rerender({ updates: undefined, cursor: undefined });
    expect(result.current.updates).toEqual([]);
    expect(first).toEqual([]);
  });
});
