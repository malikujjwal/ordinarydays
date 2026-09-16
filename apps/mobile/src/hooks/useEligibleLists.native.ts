import type { List } from '@od/shared/types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';

interface EligibleListsView {
  readonly lists: readonly List[];
  readonly status: 'pending' | 'success' | 'error';
  readonly complete: boolean;
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

/** Guards against a read from an old account session updating the new session's screen. */
function isCurrentSession(state: ReturnType<typeof requireActiveNativeState>): boolean {
  try {
    return requireActiveNativeState() === state;
  } catch {
    return false;
  }
}

/**
 * Every list the viewer holds on native, read from the subscribed SQLite projection (ADR-057).
 *
 * Native list mutations write this projection in the same transaction as their outbox intent.
 * That makes capability changes and newly-created optimistic rows visible here immediately;
 * TanStack is deliberately not a second source of list truth. A pull only refreshes the same
 * projection and never supplies rows directly to this hook.
 */
export function useEligibleLists(enabled = true): EligibleListsView {
  const { state, listsRepository, sync, pullListsMethod } = requireListsDependencies();
  const pullLists = useCallback(
    () => pullListsMethod.call(sync),
    [pullListsMethod, sync],
  );
  const [view, setView] = useState<EligibleListsView>({
    lists: [],
    status: 'pending',
    complete: false,
  });
  const active = useRef(false);
  const generation = useRef(0);

  const loadCommitted = useCallback(
    async (requiredRevision?: number): Promise<void> => {
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
            return;
          }
          if (
            requiredRevision !== undefined &&
            snapshot.commitRevision < requiredRevision
          ) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
            continue;
          }
          setView({ lists: snapshot.lists, status: 'success', complete: true });
          return;
        } catch {
          if (
            !active.current ||
            generation.current !== requestGeneration ||
            !isCurrentSession(state)
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          retryDelayMs = Math.min(retryDelayMs * 2, 2_000);
        }
      }
    },
    [listsRepository, state],
  );

  useEffect(() => {
    if (!enabled) {
      active.current = false;
      generation.current += 1;
      setView({ lists: [], status: 'pending', complete: false });
      return;
    }

    active.current = true;
    const stop = listsRepository.subscribe((metadata) => {
      if (active.current) void loadCommitted(metadata.commitRevision);
    });
    void loadCommitted().then(() => {
      if (active.current && isCurrentSession(state))
        void pullLists().catch(() => undefined);
    });

    return () => {
      active.current = false;
      generation.current += 1;
      stop();
    };
  }, [enabled, listsRepository, loadCommitted, pullLists, state]);

  return view;
}
