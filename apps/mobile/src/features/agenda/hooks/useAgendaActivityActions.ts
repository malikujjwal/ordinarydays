import {
  completeActivity,
  scheduleActivity,
  snoozeActivity,
  uncompleteActivity,
  unsnoozeActivity,
} from '@od/shared/client';
import { addWallDays } from '@od/shared/recurrence';
import type { ActivityListItem, AgendaData, AgendaItem } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { apiClient } from '@/lib/apiClient';
import { startUndoable } from '@/lib/startUndoable';
import { useToast } from '@/stores/toast';
import { applyCompletion } from '../model/applyCompletion';
import { applyReschedule } from '../model/applyReschedule';
import { applySnooze } from '../model/applySnooze';
import type { AgendaSwipeAction } from '../model/swipeActions';

interface CompletionVariables {
  activityId: string;
  occurrenceDate?: string;
  idempotencyKey: string;
}

interface ActivityListCache {
  pages: Array<{ data: ActivityListItem[] }>;
}

export interface UseAgendaActivityActionsOptions {
  today: string;
  currentMinute: string;
  timezone: string;
  getScrollOffset?: () => number;
  restoreScrollOffset?: (offset: number) => void;
}

/** Immediate agenda completion with cache/scroll rollback and compensating Undo. */
export function useAgendaActivityActions(options: UseAgendaActivityActionsOptions) {
  const queryClient = useQueryClient();
  const complete = useMutation({
    mutationFn: ({ activityId, occurrenceDate, idempotencyKey }: CompletionVariables) =>
      completeActivity(
        apiClient,
        activityId,
        occurrenceDate === undefined ? {} : { occurrenceDate },
        idempotencyKey,
      ),
  });
  const uncomplete = useMutation({
    mutationFn: ({ activityId, occurrenceDate, idempotencyKey }: CompletionVariables) =>
      uncompleteActivity(
        apiClient,
        activityId,
        occurrenceDate === undefined ? {} : { occurrenceDate },
        idempotencyKey,
      ),
  });
  const snoozeMutation = useMutation({
    mutationFn: ({ item, until }: { item: AgendaItem; until: string }) =>
      snoozeActivity(
        apiClient,
        item.activityId,
        {
          ...(item.isRecurring && item.occurrenceDate !== undefined
            ? { occurrenceDate: item.occurrenceDate }
            : {}),
          until,
        },
        randomUUID(),
      ),
  });
  const unsnoozeMutation = useMutation({
    mutationFn: (item: AgendaItem) =>
      unsnoozeActivity(
        apiClient,
        item.activityId,
        item.isRecurring && item.occurrenceDate !== undefined
          ? { occurrenceDate: item.occurrenceDate }
          : {},
        randomUUID(),
      ),
  });
  const scheduleMutation = useMutation({
    mutationFn: ({ item, date }: { item: AgendaItem; date: string }) =>
      scheduleActivity(
        apiClient,
        item.activityId,
        {
          date,
          ...(item.time === undefined ? {} : { time: item.time }),
          ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
          timezone: options.timezone,
        },
        randomUUID(),
      ),
  });

  const toggleComplete = useCallback(
    (item: AgendaItem, checked: boolean) => {
      const snapshots = queryClient.getQueriesData<AgendaData>({ queryKey: ['agenda'] });
      const anytimeSnapshots = queryClient.getQueriesData<ActivityListCache>({
        queryKey: ['activities', 'saved'],
      });
      const scrollOffset = options.getScrollOffset?.() ?? 0;
      const target = {
        activityId: item.activityId,
        ...(item.occurrenceDate === undefined
          ? {}
          : { occurrenceDate: item.occurrenceDate }),
      };
      const project = () => {
        for (const [key, cached] of snapshots) {
          if (cached === undefined) continue;
          queryClient.setQueryData(
            key,
            applyCompletion(cached, {
              ...target,
              today: options.today,
              currentMinute: options.currentMinute,
              ...(checked
                ? { completed: true }
                : {
                    completed: false,
                    restoredStatus:
                      item.status === 'saved'
                        ? ('saved' as const)
                        : ('scheduled' as const),
                  }),
            }),
          );
        }
        for (const [key, cached] of anytimeSnapshots) {
          if (cached === undefined) continue;
          queryClient.setQueryData(key, {
            ...cached,
            pages: cached.pages.map((page) => ({
              ...page,
              data: page.data.map((candidate) =>
                candidate.activityId === item.activityId
                  ? {
                      ...candidate,
                      status: checked ? ('completed' as const) : ('saved' as const),
                    }
                  : candidate,
              ),
            })),
          });
        }
      };
      const restore = () => {
        for (const [key, cached] of snapshots) queryClient.setQueryData(key, cached);
        for (const [key, cached] of anytimeSnapshots)
          queryClient.setQueryData(key, cached);
      };
      const original = { ...target, idempotencyKey: randomUUID() };
      const compensation = { ...target, idempotencyKey: randomUUID() };

      startUndoable({
        apply: project,
        revert: restore,
        restorePosition: () => options.restoreScrollOffset?.(scrollOffset),
        request: () =>
          checked ? complete.mutateAsync(original) : uncomplete.mutateAsync(original),
        compensate: () =>
          checked
            ? uncomplete.mutateAsync(compensation)
            : complete.mutateAsync(compensation),
        toast: {
          showUndo: useToast.getState().showUndo,
          failUndo: useToast.getState().failUndo,
        },
        message: checked ? 'Task completed' : 'Completion undone',
        failureMessage: checked
          ? "Couldn't complete this task."
          : "Couldn't undo this completion.",
      });
    },
    [complete, options, queryClient, uncomplete],
  );

  const onAgendaAction = useCallback(
    (item: AgendaItem, action: AgendaSwipeAction) => {
      if (action.name === 'complete') toggleComplete(item, true);
      if (action.name === 'undo' || action.name === 'undoSkip') {
        toggleComplete(item, false);
      }
    },
    [toggleComplete],
  );

  const snooze = useCallback(
    (item: AgendaItem, until: string) => {
      if (
        !item.capabilities.snooze ||
        item.time === undefined ||
        (item.isRecurring && item.occurrenceDate === undefined)
      ) {
        return;
      }
      const snapshots = queryClient.getQueriesData<AgendaData>({ queryKey: ['agenda'] });
      const scrollOffset = options.getScrollOffset?.() ?? 0;
      const target = {
        activityId: item.activityId,
        ...(item.isRecurring ? { occurrenceDate: item.occurrenceDate } : {}),
      };
      const project = () => {
        for (const [key, cached] of snapshots) {
          if (cached === undefined) continue;
          queryClient.setQueryData(
            key,
            applySnooze(cached, {
              ...target,
              today: options.today,
              currentMinute: options.currentMinute,
              date: options.today,
              snoozed: true,
              time: until,
            }),
          );
        }
      };
      const undoProjection = () => {
        for (const [key, cached] of snapshots) {
          if (cached === undefined) continue;
          queryClient.setQueryData(
            key,
            applySnooze(cached, {
              ...target,
              today: options.today,
              currentMinute: options.currentMinute,
              date: options.today,
              snoozed: false,
            }),
          );
        }
      };
      const restoreSnapshot = () => {
        for (const [key, cached] of snapshots) queryClient.setQueryData(key, cached);
      };

      startUndoable({
        apply: project,
        revert: undoProjection,
        rollbackFailure: restoreSnapshot,
        restorePosition: () => options.restoreScrollOffset?.(scrollOffset),
        request: () => snoozeMutation.mutateAsync({ item, until }),
        compensate: () => unsnoozeMutation.mutateAsync(item),
        toast: {
          showUndo: useToast.getState().showUndo,
          failUndo: useToast.getState().failUndo,
        },
        message: 'Task snoozed',
        failureMessage: "Couldn't snooze this task.",
        compensationFailureMessage: "Couldn't undo this snooze.",
      });
    },
    [options, queryClient, snoozeMutation, unsnoozeMutation],
  );

  const moveToTomorrow = useCallback(
    (item: AgendaItem) => {
      if (!item.capabilities.snooze || item.isRecurring || item.time === undefined)
        return;
      const itemTime = item.time;
      const snapshots = queryClient.getQueriesData<AgendaData>({ queryKey: ['agenda'] });
      const scrollOffset = options.getScrollOffset?.() ?? 0;
      const tomorrow = addWallDays(options.today, 1);
      const project = () => {
        for (const [key, cached] of snapshots) {
          if (cached === undefined) continue;
          queryClient.setQueryData(
            key,
            applyReschedule(cached, {
              activityId: item.activityId,
              today: options.today,
              currentMinute: options.currentMinute,
              date: tomorrow,
              time: itemTime,
              ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
            }),
          );
        }
      };
      const restore = () => {
        for (const [key, cached] of snapshots) queryClient.setQueryData(key, cached);
      };

      startUndoable({
        apply: project,
        revert: restore,
        restorePosition: () => options.restoreScrollOffset?.(scrollOffset),
        request: () => scheduleMutation.mutateAsync({ item, date: tomorrow }),
        compensate: () => scheduleMutation.mutateAsync({ item, date: options.today }),
        toast: {
          showUndo: useToast.getState().showUndo,
          failUndo: useToast.getState().failUndo,
        },
        message: 'Moved to tomorrow',
        failureMessage: "Couldn't move this task.",
        compensationFailureMessage: "Couldn't undo this move.",
      });
    },
    [options, queryClient, scheduleMutation],
  );

  return { toggleComplete, onAgendaAction, snooze, moveToTomorrow };
}
