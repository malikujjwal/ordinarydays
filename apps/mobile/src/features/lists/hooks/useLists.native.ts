import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useIsOffline } from '@/hooks/usePendingIntents';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { resolveViewerTimezone } from '@/lib/viewerTimezone';
import type { ListsView } from './useLists';

/**
 * The Lists index on **native**: typed SQLite rows, served through repository subscriptions and
 * refreshed through the one serialized sync engine (ADR-057, P3-25).
 *
 * ## TanStack is never the domain authority here
 *
 * The only thing this hook reads from the query client is the **timezone**, which is profile
 * state rather than list state. Every list row comes from `ListsRepository`. That is the whole
 * of the pivot: a screen that fell back to a query cache would hold a second copy of the truth,
 * and the two would disagree precisely when it mattered — offline, or mid-sync.
 *
 * ## Read-side only
 *
 * There is no create path here and no outbox involvement. P3-26 adds creation and joins the
 * transactional outbox at that point; until then the sync engine's drain is the only writer of
 * `list_rows`.
 *
 * ## `hasMore` is always false, and that is not a shortcut
 *
 * `pullLists` drains **every** cursor before it writes anything, so what a subscriber reads is
 * always the complete index rather than a prefix. The screen's drain rule still runs — it is
 * the same code on both platforms — and simply finds nothing left to ask for. The alternative,
 * exposing SQLite as a paged source, would mean materializing a partial order and presenting it
 * as complete, which is exactly what the `No lists yet` rule cannot survive.
 */

interface NativeListsView {
  readonly status: 'pending' | 'success' | 'error';
  readonly lists: readonly List[];
  readonly message?: string;
}

function requireListsDependencies() {
  const state = requireActiveNativeState();
  if (state.lists === undefined || state.sync.pullLists === undefined) {
    throw new Error('Native Lists state is not ready.');
  }
  return {
    state,
    listsRepository: state.lists,
    sync: state.sync,
    pullListsMethod: state.sync.pullLists,
  };
}

/** Guards against a session swap landing a stale read on the new account's screen. */
function isCurrentSession(state: ReturnType<typeof requireActiveNativeState>): boolean {
  try {
    return requireActiveNativeState() === state;
  } catch {
    return false;
  }
}

export function useLists(): ListsView {
  const { state, listsRepository, sync, pullListsMethod } = requireListsDependencies();
  const pullLists = useCallback(
    () => pullListsMethod.call(sync),
    [pullListsMethod, sync],
  );
  const isOffline = useIsOffline();
  const queryClient = useQueryClient();
  const timezone = resolveViewerTimezone(queryClient);

  const [view, setView] = useState<NativeListsView>({ status: 'pending', lists: [] });
  const active = useRef(false);
  const generation = useRef(0);
  const latest = useRef<readonly List[]>([]);

  /**
   * Reads the committed projection, waiting for a required revision when a subscription named
   * one.
   *
   * The revision wait is what makes a mutation's own refresh honest: a write commits at
   * revision N and the subscriber is told so, and reading before the WAL snapshot reaches N
   * would render the state the write replaced. The backoff is bounded per attempt and the
   * generation counter drops any read a newer one has superseded — the `useAnytime` precedent,
   * unchanged, because the failure it prevents is the same one.
   */
  const loadCommitted = useCallback(
    async (
      requiredRevision?: number,
      emptyIsSuccess = false,
    ): Promise<readonly List[] | undefined> => {
      const requestGeneration = generation.current + 1;
      generation.current = requestGeneration;
      let retryDelayMs = 50;

      while (active.current && generation.current === requestGeneration) {
        try {
          const snapshot = await listsRepository.readSnapshot();
          if (
            !active.current ||
            generation.current !== requestGeneration ||
            !isCurrentSession(state)
          ) {
            return undefined;
          }
          if (
            requiredRevision !== undefined &&
            snapshot.commitRevision < requiredRevision
          ) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
            continue;
          }
          latest.current = snapshot.lists;
          setView((current) => ({
            status:
              emptyIsSuccess || snapshot.lists.length > 0 || current.status !== 'pending'
                ? 'success'
                : 'pending',
            lists: snapshot.lists,
          }));
          return snapshot.lists;
        } catch {
          if (
            !active.current ||
            generation.current !== requestGeneration ||
            !isCurrentSession(state)
          ) {
            return undefined;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
        }
      }
      return undefined;
    },
    [listsRepository, state],
  );

  /**
   * Committed rows first, then the network.
   *
   * Order matters: showing what SQLite already holds before asking the server is what makes the
   * screen usable offline and instant on a warm start. A failed pull keeps those rows and
   * records the error beside them — `interaction-contract.md` §5.3's refresh-failure class,
   * where cached content stays and a banner appears. Only an empty index becomes an error
   * state, because there is then nothing to keep.
   */
  const refetch = useCallback(async () => {
    const committed = await loadCommitted();
    if (!active.current || !isCurrentSession(state)) return;
    try {
      await pullLists();
      await loadCommitted(undefined, true);
    } catch (error) {
      if (!active.current || !isCurrentSession(state)) return;
      const lists = committed ?? latest.current;
      setView({
        status: lists.length > 0 ? 'success' : 'error',
        lists,
        message: error instanceof Error ? error.message : "Couldn't load this.",
      });
    }
  }, [loadCommitted, pullLists, state]);

  useFocusEffect(
    useCallback(() => {
      active.current = true;
      const reload = (metadata: { readonly commitRevision?: number }) => {
        if (active.current) void loadCommitted(metadata.commitRevision, true);
      };
      const stop = listsRepository.subscribe(reload);
      void refetch();
      return () => {
        active.current = false;
        generation.current += 1;
        stop();
      };
    }, [listsRepository, loadCommitted, refetch]),
  );

  return {
    ...view,
    timezone: timezone as TimeZone,
    refetch: () => void refetch(),
    isLoadingMore: false,
    isOffline,
    // The drain is complete before anything is committed; see the header.
    hasMore: false,
    loadMore: () => undefined,
  };
}
