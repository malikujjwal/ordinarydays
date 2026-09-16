import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAddIngredients } from '@/features/activity/hooks/useAddIngredients';
import { useCreateList } from '@/features/lists/hooks/useCreateList.native';
import { useListSettings } from '@/features/lists/hooks/useListSettings.native';
import { destinationCapableLists } from '@/lib/destinationCapability';
import { INGREDIENT_DESTINATION_UNAVAILABLE } from '@/lib/ingredientDestinationValidationError';
import { readCommitRevision } from '@/lib/sqlite/commitRevision';
import type { SqliteDatabase, SqliteReader } from '@/lib/sqlite/database';
import { ListsRepository } from '@/lib/sqlite/listsRepository';
import { FOUNDATION_MIGRATIONS, runMigrations } from '@/lib/sqlite/migrations';
import { OutboxRepository } from '@/lib/sqlite/outbox';
import type { RevisionedProjectionReader } from '@/lib/sqlite/projectionReader';
import { RepositorySubscriptions } from '@/lib/sqlite/subscriptions';
import { SerializedTransactionRunner } from '@/lib/sqlite/transaction';
import { useToast } from '@/stores/toast';
import { createNodeSqliteFactory } from '../../test/node-sqlite';
import { useEligibleLists } from './useEligibleLists.native';

const nativeState = vi.hoisted(() => ({ current: undefined as unknown }));
const crypto = vi.hoisted(() => ({ nextUuid: 1 }));
const api = vi.hoisted(() => ({ addIngredients: vi.fn() }));

vi.mock('@/lib/sqlite/nativeState', () => ({
  getActiveNativeState: () => nativeState.current,
  requireActiveNativeState: () => nativeState.current,
}));
vi.mock(
  '@/lib/ingredientDestinationValidation',
  async () => import('@/lib/ingredientDestinationValidation.native'),
);
vi.mock('@od/shared/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@od/shared/client')>();
  return { ...actual, addIngredientsToList: api.addIngredients };
});
vi.mock('expo-crypto', () => ({
  randomUUID: () => `intent_native_${crypto.nextUuid++}`,
  getRandomBytes: (size: number) => new Uint8Array(size).fill(1),
}));

const ACTIVITY = 'act_01J0000000000000000000000A';
const INGREDIENT = 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2';

const GROCERIES: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 0,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-09-16T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-09-16T12:00:00.000Z'),
};

describe('the native eligible-list source', () => {
  let directory = '';
  let database: SqliteDatabase | undefined;
  let transactions: SerializedTransactionRunner | undefined;
  let lists: ListsRepository | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ordinarydays-eligible-lists-'));
    const opened = await createNodeSqliteFactory(directory).open('eligible-lists.sqlite');
    database = opened;
    await runMigrations(opened, FOUNDATION_MIGRATIONS);
    const subscriptions = new RepositorySubscriptions();
    transactions = new SerializedTransactionRunner(opened, subscriptions);
    const projections: RevisionedProjectionReader = {
      snapshot: <T,>(task: (reader: SqliteReader) => Promise<T>) =>
        opened.readTransaction(async (reader) => {
          const commitRevision = await readCommitRevision(reader);
          const data = await task(reader);
          return {
            data,
            commitRevision,
            source: 'reader' as const,
            metrics: { callCount: 0, durationMs: 0 },
          };
        }),
    };
    lists = new ListsRepository(opened, subscriptions, projections);
    const outbox = new OutboxRepository(opened);
    const pullLists = vi.fn(() => Promise.resolve(lists?.read() ?? []));
    nativeState.current = {
      ownerUserId: 'usr_local_dev',
      account: { transactions },
      lists,
      outbox,
      sync: { pullLists, request: vi.fn() },
    };
    crypto.nextUuid = 1;
    api.addIngredients.mockReset();
    api.addIngredients.mockResolvedValue({ listId: GROCERIES.listId, ingredients: [] });
    useToast.setState({ current: undefined });
  });

  afterEach(async () => {
    nativeState.current = undefined;
    await transactions?.shutdown();
    await database?.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function install(list: List): Promise<void> {
    if (transactions === undefined || lists === undefined) throw new Error('not ready');
    const repository = lists;
    await transactions.run((transaction) =>
      repository.replaceCanonical(transaction, [list]),
    );
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function queryWrapper() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  it('drops a selected ingredient destination immediately after native settings remove checkbox state', async () => {
    await install(GROCERIES);
    const mounted = renderHook(() => {
      const eligible = useEligibleLists();
      const current = eligible.lists.find((list) => list.listId === GROCERIES.listId);
      const settings = useListSettings({
        list: current,
        onChanged: vi.fn(),
        onServerChanged: vi.fn(),
      });
      return { eligible, settings };
    });

    await waitFor(() => expect(mounted.result.current.eligible.status).toBe('success'));
    expect(
      destinationCapableLists('groceries', mounted.result.current.eligible.lists).find(
        (list) => list.listId === GROCERIES.listId,
      )?.title,
    ).toBe('Groceries');

    act(() => mounted.result.current.settings.setStateMode({ mode: 'none' }));

    await waitFor(() =>
      expect(
        mounted.result.current.eligible.lists.find(
          (list) => list.listId === GROCERIES.listId,
        )?.itemStateMode,
      ).toEqual({ mode: 'none' }),
    );
    // useDestination resolves overrides from this exact capable set, so the stale id can no
    // longer be offered or reach IngredientsSection's add mutation.
    expect(
      destinationCapableLists('groceries', mounted.result.current.eligible.lists).some(
        (list) => list.listId === GROCERIES.listId,
      ),
    ).toBe(false);
  });

  it('refuses an add from the committed projection while its picker refresh is still pending', async () => {
    await install(GROCERIES);
    const wrapper = queryWrapper();
    const mounted = renderHook(
      () => {
        const eligible = useEligibleLists();
        const current = eligible.lists.find((list) => list.listId === GROCERIES.listId);
        return {
          eligible,
          settings: useListSettings({
            list: current,
            onChanged: vi.fn(),
            onServerChanged: vi.fn(),
          }),
          add: useAddIngredients(ACTIVITY, { onSettledSelection: vi.fn() }),
        };
      },
      { wrapper },
    );

    await waitFor(() => expect(mounted.result.current.eligible.status).toBe('success'));
    if (lists === undefined) throw new Error('not ready');
    const repository = lists;
    const stalePickerRead =
      deferred<Awaited<ReturnType<typeof repository.readSnapshot>>>();
    const readSnapshot = vi
      .spyOn(repository, 'readSnapshot')
      .mockImplementationOnce(() => stalePickerRead.promise);

    act(() => mounted.result.current.settings.setStateMode({ mode: 'none' }));
    await waitFor(() => expect(readSnapshot).toHaveBeenCalledOnce());
    expect(mounted.result.current.eligible).toEqual({
      lists: [],
      status: 'pending',
      complete: false,
    });

    act(() =>
      mounted.result.current.add.mutate({
        listId: GROCERIES.listId,
        ingredientIds: [INGREDIENT],
      }),
    );

    await waitFor(() =>
      expect(useToast.getState().current).toMatchObject({
        kind: 'message',
        tone: 'error',
        message: INGREDIENT_DESTINATION_UNAVAILABLE,
      }),
    );
    expect(api.addIngredients).not.toHaveBeenCalled();
    expect(readSnapshot).toHaveBeenCalledTimes(2);

    stalePickerRead.resolve(await repository.readSnapshot());
    await waitFor(() => expect(mounted.result.current.eligible.status).toBe('success'));
    mounted.unmount();
  });

  it('does not present a previous eligible set after a projection read fails', async () => {
    await install(GROCERIES);
    const mounted = renderHook(() => useEligibleLists());
    await waitFor(() => expect(mounted.result.current.status).toBe('success'));

    if (lists === undefined) throw new Error('not ready');
    const readSnapshot = vi
      .spyOn(lists, 'readSnapshot')
      .mockRejectedValue(new Error('projection unavailable'));
    await act(async () => install({ ...GROCERIES, itemStateMode: { mode: 'none' } }));

    await waitFor(() => expect(readSnapshot).toHaveBeenCalled());
    expect(mounted.result.current).toEqual({
      lists: [],
      status: 'pending',
      complete: false,
    });
    mounted.unmount();
  });

  it('names a native-created eligible list before any server sync completes', async () => {
    const mounted = renderHook(() => ({
      eligible: useEligibleLists(),
      create: useCreateList(),
    }));
    await waitFor(() => expect(mounted.result.current.eligible.status).toBe('success'));

    let createdId: string | undefined;
    await act(async () => {
      createdId = await mounted.result.current.create.create(
        'groceries',
        'Trip groceries',
      );
    });
    expect(createdId).toBeDefined();

    await waitFor(() =>
      expect(
        destinationCapableLists('groceries', mounted.result.current.eligible.lists).find(
          (list) => list.listId === createdId,
        )?.title,
      ).toBe('Trip groceries'),
    );
  });
});
