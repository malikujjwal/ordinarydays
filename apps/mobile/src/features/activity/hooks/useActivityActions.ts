import { type ChangeTarget, changeActivityKind } from '@od/shared';
import {
  ApiError,
  completeActivity,
  deleteActivity,
  duplicateActivity,
  uncompleteActivity,
} from '@od/shared/client';
import type { PatchActivityInput } from '@od/shared/schemas';
import type { Activity, AgendaData, AgendaItem } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useCallback } from 'react';
import { applyCompletion } from '@/features/agenda/model/applyCompletion';
import type { AgendaSwipeAction } from '@/features/agenda/model/swipeActions';
import { startUndoable } from '@/features/undo/startUndoable';
import { apiClient } from '@/lib/apiClient';
import { useToast } from '@/stores/toast';

/**
 * The three `⋯` actions: change kind, duplicate, delete (P1-27).
 *
 * They live in one hook because they are one menu and share one failure presentation, and
 * because each is a single write with no optimistic update — none of them is a row toggle the
 * user should see move before the server agrees. Delete and duplicate navigate afterwards,
 * and a screen that navigated away from an optimistic write that then failed would be the
 * worst version of this.
 *
 * `patch` is the detail screen's existing mutation (P1-26) rather than a second one here: a
 * kind change is a `PATCH` with `If-Match` exactly like a title edit, and having two mutations
 * on one resource is how two `updatedAt` values start disagreeing.
 */
export interface ActivityActions {
  duplicate: () => Promise<Activity | undefined>;
  remove: () => Promise<boolean>;
  isBusy: boolean;
  /** `interaction-contract.md` §5.3 copy for whichever action failed. */
  errorMessage: string | undefined;
  dismissError: () => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return 'Only the person who made this plan can change that.';
    }
    if (error.status === 404) return "This isn't here any more.";
    if (error.status >= 500) return 'Something went wrong.';
    return error.message;
  }
  return "Couldn't do that.";
}

export function useActivityActions(activityId: string): ActivityActions {
  const queryClient = useQueryClient();

  const duplicateMutation = useMutation({
    /**
     * A creating `POST`, so it carries an `Idempotency-Key` generated once per attempt
     * (`api-contract.md` §1). Without it the transport refuses to retry at all, and a dropped
     * response on a flaky connection becomes a failed duplicate rather than a recovered one.
     */
    mutationFn: () => duplicateActivity(apiClient, activityId, randomUUID()),
    onSuccess: () => {
      // The copy is a new row in every list that could show it.
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
    retry: false,
    networkMode: 'always',
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteActivity(apiClient, activityId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['activity', activityId] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
    retry: false,
    networkMode: 'always',
  });

  const failure = duplicateMutation.error ?? deleteMutation.error;

  return {
    duplicate: async () => {
      try {
        return await duplicateMutation.mutateAsync();
      } catch {
        // Handled: the message is on the mutation and rendered as the banner. Rethrowing
        // would surface an unhandled rejection for a failure the UI has absorbed.
        return undefined;
      }
    },
    remove: async () => {
      try {
        await deleteMutation.mutateAsync();
        return true;
      } catch {
        return false;
      }
    },
    isBusy: duplicateMutation.isPending || deleteMutation.isPending,
    errorMessage:
      failure === null || failure === undefined ? undefined : describe(failure),
    dismissError: () => {
      duplicateMutation.reset();
      deleteMutation.reset();
    },
  };
}

interface CompletionVariables {
  activityId: string;
  occurrenceDate?: string;
  idempotencyKey: string;
}

export interface UseAgendaActivityActionsOptions {
  today: string;
  currentMinute: string;
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

  const toggleComplete = useCallback(
    (item: AgendaItem, checked: boolean) => {
      const snapshots = queryClient.getQueriesData<AgendaData>({ queryKey: ['agenda'] });
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
      };
      const restore = () => {
        for (const [key, cached] of snapshots) queryClient.setQueryData(key, cached);
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

  return { toggleComplete, onAgendaAction };
}

/**
 * The `PATCH` body for a kind change (`activities.md` §6.3 rules 5 and 8).
 *
 * Built from **P1-17's mapping**, not from the target alone, so the body carries the mapped
 * `details` — and the `notes` and `location` the mapping folded fields into, which is how
 * Leaving Event carries its description into notes and names any reservation fields lost.
 *
 * `objectKind` and `type` always travel together: the schema rejects one without the other,
 * because "the server never chooses one from the other".
 */
export function kindChangePatch(
  activity: Activity,
  target: ChangeTarget,
): PatchActivityInput {
  const result = changeActivityKind(activity, target);

  return {
    objectKind: result.objectKind,
    type: result.type,
    details: result.details,
    ...(result.notes === undefined ? {} : { notes: result.notes }),
    ...(result.location === undefined ? {} : { location: result.location }),
  };
}
