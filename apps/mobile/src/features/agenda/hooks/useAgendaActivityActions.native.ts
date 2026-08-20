import { addWallDays } from '@od/shared/recurrence';
import type { ActivityOutcome, AgendaData, AgendaItem } from '@od/shared/types';
import { scopeToWire } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import {
  completionCommitGateFor,
  completionTargetKey,
} from '@/features/agenda/completionCommitGate';
import type { NativeActionResult } from '@/lib/sqlite/actionCoordinator';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';
import {
  isFutureRecurringOccurrence,
  scopeForRow,
  wouldCompleteWholeSeries,
} from '../model/rowScope';
import type { AgendaSwipeAction } from '../model/swipeActions';

export interface UseAgendaActivityActionsOptions {
  today: string;
  currentMinute: string;
  timezone: string;
  agendaData?: AgendaData;
  getScrollOffset?: () => number;
  restoreScrollOffset?: (offset: number) => void;
}

function refused(message: string): void {
  useToast.getState().show({ message, tone: 'error', duration: 10000 });
}

function viewerDateFor(data: AgendaData | undefined, item: AgendaItem): string {
  const key = completionTargetKey(item);
  for (const day of data?.days ?? []) {
    const found = [
      ...(day.upNext === undefined ? [] : [day.upNext]),
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ].some((candidate) => completionTargetKey(candidate) === key);
    if (found) return day.date;
  }
  return item.occurrenceDate ?? '';
}

/** Native Activity/Agenda actions publish only SQLite state committed with their outbox row. */
export function useAgendaActivityActions(options: UseAgendaActivityActionsOptions) {
  const state = requireActiveNativeState();
  const completionGate = completionCommitGateFor(state.coordinator);
  const settleCompletion = useCallback(
    (item: AgendaItem, checked: boolean, result: NativeActionResult) => {
      completionGate.settle(
        item,
        checked,
        result.kind !== 'refused',
        result.kind === 'refused' ? undefined : result.commitRevision,
      );
    },
    [completionGate],
  );

  const toggleComplete = useCallback(
    (item: AgendaItem, checked: boolean) => {
      if (wouldCompleteWholeSeries(item)) return;
      if (checked && isFutureRecurringOccurrence(item, options.today)) return;
      const originalIntentId = randomUUID();
      const inverseIntentId = randomUUID();
      const viewerDate = viewerDateFor(options.agendaData, item);
      if (!completionGate.begin(item, checked, originalIntentId, viewerDate)) return;
      const wireScope = scopeToWire(scopeForRow(item));
      const scrollOffset = options.getScrollOffset?.() ?? 0;
      void state.coordinator
        .complete(
          item.activityId,
          originalIntentId,
          wireScope,
          checked,
          item.status === 'saved' ? 'saved' : 'scheduled',
          options,
        )
        .then((result) => {
          settleCompletion(item, checked, result);
          if (result.kind === 'refused') {
            refused(result.error.message);
            return;
          }
          useToast.getState().showUndo({
            message: checked ? 'Task completed' : 'Completion undone',
            onCommit: () => undefined,
            onUndo: () => {
              const inverseChecked = !checked;
              if (
                !completionGate.begin(item, inverseChecked, inverseIntentId, viewerDate)
              )
                return;
              const inverse = {
                activityId: item.activityId,
                idempotencyKey: inverseIntentId,
                input: wireScope,
              };
              void state.coordinator
                .undoCompletion(
                  originalIntentId,
                  inverse,
                  inverseChecked,
                  item.status === 'saved' ? 'saved' : 'scheduled',
                  options,
                )
                .then((undo) => {
                  settleCompletion(item, inverseChecked, undo);
                  if (undo.kind === 'refused') refused(undo.error.message);
                  else options.restoreScrollOffset?.(scrollOffset);
                });
            },
          });
        });
    },
    [completionGate, options, settleCompletion, state],
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

  const resolvePassed = useCallback(
    (item: AgendaItem, outcome: ActivityOutcome) => {
      if (!item.isPast || item.status !== 'scheduled' || !item.capabilities.complete)
        return;
      if (wouldCompleteWholeSeries(item)) return;
      const variables = {
        activityId: item.activityId,
        idempotencyKey: randomUUID(),
        input: { outcome, ...scopeToWire(scopeForRow(item)) },
      };
      if (
        !completionGate.begin(
          item,
          true,
          variables.idempotencyKey,
          viewerDateFor(options.agendaData, item),
        )
      )
        return;
      const request = state.coordinator.complete(
        item.activityId,
        variables.idempotencyKey,
        variables.input,
        true,
        'scheduled',
        options,
      );
      void request.then((result) => {
        settleCompletion(item, true, result);
        if (result.kind === 'refused') refused(result.error.message);
      });
    },
    [completionGate, options, settleCompletion, state],
  );

  const snooze = useCallback(
    (item: AgendaItem, until: string) => {
      if (
        !item.capabilities.snooze ||
        item.time === undefined ||
        wouldCompleteWholeSeries(item)
      ) {
        return;
      }
      void state.coordinator
        .snooze(
          {
            activityId: item.activityId,
            idempotencyKey: randomUUID(),
            input: { ...scopeToWire(scopeForRow(item)), until },
          },
          true,
          options.today,
          options,
        )
        .then((result) => {
          if (result.kind === 'refused') refused(result.error.message);
        });
    },
    [options, state],
  );

  const moveToTomorrow = useCallback(
    (item: AgendaItem) => {
      if (!item.capabilities.snooze || item.isRecurring || item.time === undefined)
        return;
      void state.coordinator
        .schedule(
          item.activityId,
          randomUUID(),
          {
            date: addWallDays(options.today, 1),
            time: item.time,
            ...(item.endTime === undefined ? {} : { endTime: item.endTime }),
            timezone: options.timezone,
          },
          options,
        )
        .then((result) => {
          if (result.kind === 'refused') refused(result.error.message);
        });
    },
    [options, state],
  );

  return {
    toggleComplete,
    onAgendaAction,
    resolvePassed,
    snooze,
    moveToTomorrow,
  };
}
