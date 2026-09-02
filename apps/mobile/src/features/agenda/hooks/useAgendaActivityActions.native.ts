import { addWallDays } from '@od/shared/recurrence';
import type { ActivityOutcome, AgendaData, AgendaItem } from '@od/shared/types';
import { scopeToWire } from '@od/shared/types';
import { randomUUID } from 'expo-crypto';
import { useCallback, useRef } from 'react';
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
  /** Anytime has its own revisioned saved-task projection instead of an Agenda day. */
  completionProjection?: 'agenda' | 'anytime';
  getScrollOffset?: () => number;
  restoreScrollOffset?: (offset: number) => void;
}

function refused(message: string): void {
  useToast.getState().show({ message, tone: 'error', duration: 10000 });
}

function isCurrentSession(state: ReturnType<typeof requireActiveNativeState>): boolean {
  try {
    return requireActiveNativeState() === state;
  } catch {
    return false;
  }
}

function failureMessage(): string {
  return "Couldn't save that change.";
}

function viewerDateFor(
  options: UseAgendaActivityActionsOptions,
  item: AgendaItem,
): string | undefined {
  if (options.completionProjection === 'anytime') return undefined;
  const key = completionTargetKey(item);
  for (const day of options.agendaData?.days ?? []) {
    const found = [
      ...(day.upNext === undefined ? [] : [day.upNext]),
      ...day.schedule,
      ...day.anytime,
      ...day.earlier,
    ].some((candidate) => completionTargetKey(candidate) === key);
    if (found) return day.date;
  }
  return item.occurrenceDate ?? options.today;
}

interface PendingCompletion {
  readonly checked: boolean;
  desiredChecked: boolean;
  readonly originalIntentId: string;
  readonly inverseIntentId: string;
  readonly promise: Promise<NativeActionResult>;
  readonly scrollOffset: number;
  inverseHandlerAttached: boolean;
}

/** Native Activity/Agenda actions publish only SQLite state committed with their outbox row. */
export function useAgendaActivityActions(options: UseAgendaActivityActionsOptions) {
  const state = requireActiveNativeState();
  const completionGate = completionCommitGateFor(state.coordinator);
  const pendingCompletions = useRef(new Map<string, PendingCompletion>());
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

  /**
   * Returns whether the tick was **accepted for dispatch** — every refusal (series scope,
   * future occurrence, the commit gate) is synchronous, so a caller that projects its own
   * surface (the Plans store) can key on the answer and never project a refused write.
   */
  const toggleComplete = useCallback(
    (item: AgendaItem, checked: boolean): boolean => {
      if (wouldCompleteWholeSeries(item)) return false;
      if (checked && isFutureRecurringOccurrence(item, options.today)) return false;
      const viewerDate = viewerDateFor(options, item);
      const targetKey = completionTargetKey(item);
      const pending = pendingCompletions.current.get(targetKey);
      if (pending !== undefined) {
        if (pending.desiredChecked === checked) return false;
        const intentId =
          checked === pending.checked
            ? pending.originalIntentId
            : pending.inverseIntentId;
        if (!completionGate.retargetCommitting(item, checked, intentId, viewerDate)) {
          return false;
        }
        pending.desiredChecked = checked;
        if (!pending.inverseHandlerAttached) {
          pending.inverseHandlerAttached = true;
          void pending.promise
            .then(async (original) => {
              const current = pendingCompletions.current.get(targetKey);
              if (current !== pending || current.desiredChecked === current.checked) {
                return;
              }
              if (original.kind === 'refused') {
                pendingCompletions.current.delete(targetKey);
                completionGate.settle(item, current.desiredChecked, false);
                return;
              }
              const inverseChecked = current.desiredChecked;
              const inverse = {
                activityId: item.activityId,
                idempotencyKey: current.inverseIntentId,
                input: scopeToWire(scopeForRow(item)),
              };
              const result = await state.coordinator.undoCompletion(
                current.originalIntentId,
                inverse,
                inverseChecked,
                item.status === 'saved' ? 'saved' : 'scheduled',
                options,
              );
              if (pendingCompletions.current.get(targetKey) === current) {
                pendingCompletions.current.delete(targetKey);
              }
              settleCompletion(item, inverseChecked, result);
              if (!isCurrentSession(state)) return;
              if (result.kind === 'refused') refused(result.error.message);
              else options.restoreScrollOffset?.(current.scrollOffset);
            })
            .catch(() => {
              const current = pendingCompletions.current.get(targetKey);
              if (current !== pending) return;
              pendingCompletions.current.delete(targetKey);
              completionGate.settle(item, current.desiredChecked, false);
              if (isCurrentSession(state)) refused(failureMessage());
            });
        }
        return true;
      }
      const originalIntentId = randomUUID();
      const inverseIntentId = randomUUID();
      if (!completionGate.begin(item, checked, originalIntentId, viewerDate)) {
        return false;
      }
      const wireScope = scopeToWire(scopeForRow(item));
      const scrollOffset = options.getScrollOffset?.() ?? 0;
      const request = state.coordinator.complete(
        item.activityId,
        originalIntentId,
        wireScope,
        checked,
        item.status === 'saved' ? 'saved' : 'scheduled',
        options,
      );
      const pendingCompletion: PendingCompletion = {
        checked,
        desiredChecked: checked,
        originalIntentId,
        inverseIntentId,
        promise: request,
        scrollOffset,
        inverseHandlerAttached: false,
      };
      pendingCompletions.current.set(targetKey, pendingCompletion);
      void request
        .then((result) => {
          const current = pendingCompletions.current.get(targetKey);
          if (current === pendingCompletion && current.desiredChecked !== checked) return;
          if (current === pendingCompletion) pendingCompletions.current.delete(targetKey);
          settleCompletion(item, checked, result);
          if (!isCurrentSession(state)) return;
          if (result.kind === 'refused') {
            refused(result.error.message);
            return;
          }
          useToast.getState().showUndo({
            message: checked ? 'Task completed' : 'Completion undone',
            onCommit: () => undefined,
            onUndo: () => {
              if (!isCurrentSession(state)) return;
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
                  if (!isCurrentSession(state)) return;
                  if (undo.kind === 'refused') refused(undo.error.message);
                  else options.restoreScrollOffset?.(scrollOffset);
                })
                .catch(() => {
                  completionGate.settle(item, inverseChecked, false);
                  if (isCurrentSession(state)) refused(failureMessage());
                });
            },
          });
        })
        .catch(() => {
          const current = pendingCompletions.current.get(targetKey);
          if (current === pendingCompletion && current.desiredChecked !== checked) return;
          if (current === pendingCompletion) pendingCompletions.current.delete(targetKey);
          completionGate.settle(item, checked, false);
          if (isCurrentSession(state)) refused(failureMessage());
        });
      return true;
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
          viewerDateFor(options, item),
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
      void request
        .then((result) => {
          settleCompletion(item, true, result);
          if (isCurrentSession(state) && result.kind === 'refused') {
            refused(result.error.message);
          }
        })
        .catch(() => {
          completionGate.settle(item, true, false);
          if (isCurrentSession(state)) refused(failureMessage());
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
