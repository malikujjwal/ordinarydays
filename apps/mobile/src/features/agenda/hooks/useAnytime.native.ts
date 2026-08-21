import type { TimeZone } from '@od/shared/time';
import type { ActivityListItem } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { completionCommitGateFor } from '@/features/agenda/completionCommitGate';
import { useIsOffline } from '@/hooks/usePendingIntents';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { resolveAgendaTimezone } from '../timezone';

interface AnytimeView {
  readonly status: 'pending' | 'success' | 'error';
  readonly items: readonly ActivityListItem[];
  readonly message?: string;
}

function requireAnytimeDependencies() {
  const state = requireActiveNativeState();
  if (state.anytime === undefined || state.sync.pullAnytime === undefined) {
    throw new Error('Native Anytime state is not ready.');
  }
  return {
    state,
    anytimeRepository: state.anytime,
    sync: state.sync,
    pullAnytimeMethod: state.sync.pullAnytime,
  };
}

function isCurrentSession(state: ReturnType<typeof requireActiveNativeState>): boolean {
  try {
    return requireActiveNativeState() === state;
  } catch {
    return false;
  }
}

/** Native Anytime reads and refreshes only through the account SQLite/sync owner. */
export function useAnytime() {
  const { state, anytimeRepository, sync, pullAnytimeMethod } =
    requireAnytimeDependencies();
  const completionGate = completionCommitGateFor(state.coordinator);
  const pullAnytime = useCallback(
    () => pullAnytimeMethod.call(sync),
    [pullAnytimeMethod, sync],
  );
  const isOffline = useIsOffline();
  const queryClient = useQueryClient();
  const timezone = resolveAgendaTimezone(queryClient);
  const [view, setView] = useState<AnytimeView>({ status: 'pending', items: [] });
  const active = useRef(false);
  const generation = useRef(0);
  const latestItems = useRef<readonly ActivityListItem[]>([]);

  const loadCommitted = useCallback(
    async (
      requiredRevision?: number,
      emptyIsSuccess = false,
    ): Promise<readonly ActivityListItem[] | undefined> => {
      const requestGeneration = generation.current + 1;
      generation.current = requestGeneration;
      let retryDelayMs = 50;
      while (active.current && generation.current === requestGeneration) {
        try {
          const snapshot = await anytimeRepository.readSnapshot();
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
          latestItems.current = snapshot.items;
          completionGate.reconcileAnytime(snapshot.items, snapshot.commitRevision);
          setView((current) => ({
            status:
              emptyIsSuccess || snapshot.items.length > 0 || current.status !== 'pending'
                ? 'success'
                : 'pending',
            items: snapshot.items,
          }));
          return snapshot.items;
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
    [anytimeRepository, completionGate, state],
  );

  const refetch = useCallback(async () => {
    const committed = await loadCommitted();
    if (!active.current || !isCurrentSession(state)) return;
    try {
      await pullAnytime();
      await loadCommitted(undefined, true);
    } catch (error) {
      if (!active.current || !isCurrentSession(state)) return;
      const items = committed ?? latestItems.current;
      setView({
        status: items.length > 0 ? 'success' : 'error',
        items,
        message: error instanceof Error ? error.message : "Couldn't load this.",
      });
    }
  }, [loadCommitted, pullAnytime, state]);

  useFocusEffect(
    useCallback(() => {
      active.current = true;
      const reload = (metadata: { readonly commitRevision?: number }) => {
        if (active.current) void loadCommitted(metadata.commitRevision, true);
      };
      const stop = anytimeRepository.subscribe(reload);
      void refetch();
      return () => {
        active.current = false;
        generation.current += 1;
        stop();
      };
    }, [anytimeRepository, loadCommitted, refetch]),
  );

  return {
    ...view,
    timezone: timezone as TimeZone,
    refetch: () => void refetch(),
    isLoadingMore: false,
    isOffline,
    hasMore: false,
    loadMore: () => undefined,
  };
}
