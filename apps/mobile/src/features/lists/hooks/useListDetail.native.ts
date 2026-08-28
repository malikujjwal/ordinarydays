import { ApiError } from '@od/shared/client';
import type { List } from '@od/shared/types';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useIsOffline } from '@/hooks/usePendingIntents';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import type { ListDetailView } from './useListDetail';

/**
 * One list's detail on **native**: typed SQLite rows, refreshed through the one serialized
 * sync engine (P3-27, ADR-057).
 *
 * ## The engine owns the `503` contract, not this hook
 *
 * `pullListDetail` keeps the committed rows, discards every cursor, waits `Retry-After` and
 * restarts at page one inside a writer transaction. So there is nothing here to reproduce:
 * this hook reads the projection and re-reads it when the repository says it changed, which
 * is the same thing it does on an ordinary refresh. The web file has to implement the
 * contract itself because it has no writer to put it behind.
 *
 * ## Committed rows first, then the network
 *
 * Showing what SQLite already holds before asking the server is what makes an open-in-a-shop
 * instant and what makes it work with no signal at all. A failed pull keeps those rows and
 * records the error beside them (`interaction-contract.md` §5.3); only an empty projection
 * becomes an error state.
 */

function requireDetailDependencies() {
  const state = requireActiveNativeState();
  if (
    state.lists === undefined ||
    state.listItems === undefined ||
    state.sync.pullListDetail === undefined ||
    state.sync.pullListItemPage === undefined
  ) {
    throw new Error('Native list item state is not ready.');
  }
  return {
    state,
    lists: state.lists,
    items: state.listItems,
    pullDetail: state.sync.pullListDetail.bind(state.sync),
    pullPage: state.sync.pullListItemPage.bind(state.sync),
  };
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    return {
      message: error.status >= 500 ? 'Something went wrong.' : error.message,
      requestId: error.requestId,
    };
  }
  return { message: error instanceof Error ? error.message : "Couldn't load this." };
}

interface Committed {
  readonly list: List | undefined;
  readonly items: readonly ListItemRow[];
  readonly complete: boolean;
  readonly hasCursor: boolean;
}

const EMPTY: Committed = {
  list: undefined,
  items: [],
  complete: false,
  hasCursor: false,
};

export function useListDetail(listId: string): ListDetailView {
  const { state, lists, items, pullDetail, pullPage } = requireDetailDependencies();
  const isOffline = useIsOffline();
  const [committed, setCommitted] = useState<Committed>(EMPTY);
  const [status, setStatus] = useState<'pending' | 'success' | 'error'>('pending');
  const [failure, setFailure] = useState<{ message: string; requestId?: string }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const active = useRef(false);
  const generation = useRef(0);

  const loadCommitted = useCallback(
    async (requiredRevision?: number) => {
      const attempt = ++generation.current;
      let delayMs = 50;
      while (active.current && generation.current === attempt) {
        try {
          const snapshot = await items.readSnapshot(listId);
          if (!active.current || generation.current !== attempt) return;
          if (
            requiredRevision !== undefined &&
            snapshot.commitRevision < requiredRevision
          ) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs = Math.min(delayMs * 2, 2_000);
            continue;
          }
          const row = await lists.getLocal(state.account.database, listId);
          if (!active.current || generation.current !== attempt) return;
          setCommitted({
            list: row,
            items: snapshot.items,
            complete: snapshot.page?.complete ?? false,
            hasCursor: snapshot.page?.nextCursor !== undefined,
          });
          // A list this device has never pulled is still `pending`; one it has is settled.
          setStatus((current) =>
            row === undefined && current === 'pending' ? 'pending' : 'success',
          );
          return;
        } catch {
          if (!active.current || generation.current !== attempt) return;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          delayMs = Math.min(delayMs * 2, 2_000);
        }
      }
    },
    [items, lists, listId, state.account.database],
  );

  const refetch = useCallback(async () => {
    await loadCommitted();
    if (!active.current) return;
    try {
      await pullDetail(listId);
      await loadCommitted();
      if (active.current) setFailure(undefined);
    } catch (error) {
      if (!active.current) return;
      setFailure(describe(error));
      setStatus((current) => (current === 'success' ? 'success' : 'error'));
    }
  }, [loadCommitted, pullDetail, listId]);

  useFocusEffect(
    useCallback(() => {
      active.current = true;
      const stop = items.subscribe(listId, (metadata) => {
        if (active.current) void loadCommitted(metadata.commitRevision);
      });
      void refetch();
      return () => {
        active.current = false;
        generation.current += 1;
        stop();
      };
    }, [items, listId, loadCommitted, refetch]),
  );

  return {
    status,
    list: committed.list,
    items: committed.items,
    itemCount: committed.list?.itemCount ?? 0,
    complete: committed.complete,
    isLoadingMore: loadingMore,
    isOffline,
    loadMore: () => {
      if (!committed.hasCursor || loadingMore) return;
      setLoadingMore(true);
      void pullPage(listId)
        .then(() => loadCommitted())
        .catch((error: unknown) => {
          if (active.current) setFailure(describe(error));
        })
        .finally(() => {
          if (active.current) setLoadingMore(false);
        });
    },
    // Committed rows only: the write already landed in SQLite, and asking the network for
    // permission to show it is what breaks adding an item on a train.
    refresh: () => void loadCommitted(),
    refetch: () => void refetch(),
    /*
     * A **write**, not a render-time overlay: on a migrated native domain, accepted state is a
     * write-time SQLite transaction and the reader is an ordinary typed repository read
     * (`interaction-contract.md` §5.4's transition invariants, ADR-057). The subscription
     * installed above notices the commit and re-reads, so the row arrives at its new position
     * through the same path every other change does.
     */
    applyRank: (itemId, rank) => {
      void state.account.transactions
        .run(
          (transaction) => items.setRankLocal(transaction, listId, itemId, rank),
          'interactive',
        )
        .catch((error: unknown) => {
          if (active.current) setFailure(describe(error));
        });
    },
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
  };
}
