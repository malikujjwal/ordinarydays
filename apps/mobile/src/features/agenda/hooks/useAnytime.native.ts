import type { TimeZone } from '@od/shared/time';
import type { ActivityListItem } from '@od/shared/types';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
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
    anytimeRepository: state.anytime,
    sync: state.sync,
    pullAnytimeMethod: state.sync.pullAnytime,
  };
}

/** Native Anytime reads and refreshes only through the account SQLite/sync owner. */
export function useAnytime() {
  const { anytimeRepository, sync, pullAnytimeMethod } = requireAnytimeDependencies();
  const pullAnytime = useCallback(
    () => pullAnytimeMethod.call(sync),
    [pullAnytimeMethod, sync],
  );
  const isOffline = useIsOffline();
  const queryClient = useQueryClient();
  const timezone = resolveAgendaTimezone(queryClient);
  const [view, setView] = useState<AnytimeView>({ status: 'pending', items: [] });

  const loadCommitted = useCallback(async () => {
    const items = await anytimeRepository.read();
    setView((current) => ({
      status: items.length > 0 || current.status !== 'pending' ? 'success' : 'pending',
      items,
    }));
    return items;
  }, [anytimeRepository]);

  const refetch = useCallback(async () => {
    const committed = await loadCommitted();
    try {
      const items = await pullAnytime();
      setView({ status: 'success', items });
    } catch (error) {
      setView({
        status: committed.length > 0 ? 'success' : 'error',
        items: committed,
        message: error instanceof Error ? error.message : "Couldn't load this.",
      });
    }
  }, [loadCommitted, pullAnytime]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const reload = () => {
        if (active) void loadCommitted();
      };
      const stop = anytimeRepository.subscribe(reload);
      void refetch();
      return () => {
        active = false;
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
