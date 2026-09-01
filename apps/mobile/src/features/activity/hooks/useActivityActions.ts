import { type ChangeTarget, changeActivityKind } from '@od/shared';
import { ApiError } from '@od/shared/client';
import type { ActivityCompletionResult, PatchActivityInput } from '@od/shared/schemas';
import type { Activity, ActivityDetail } from '@od/shared/types';
import { type ActivityScope, scopeToWire, targetsWholeSeries } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useRef } from 'react';
import { projectOptimisticCompletion, projectOptimisticSnooze } from '@/lib/agendaCache';
import type {
  CompleteActivityVariables,
  DeleteActivityVariables,
  DuplicateActivityVariables,
  SkipActivityVariables,
  SnoozeActivityVariables,
  UncompleteActivityVariables,
} from '@/lib/mutationDefaults';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { startUndoable } from '@/lib/startUndoable';
import { useToast } from '@/stores/toast';
import {
  type ActivityActions,
  describeActionFailure,
  OUTCOME_RECORDED,
} from '../model/activityActions';

export type { ActivityActions } from '../model/activityActions';

import { activityKey } from './useActivity';

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

/**
 * A completion that would land on a series rather than on one of its days.
 *
 * `POST /complete` sent without an `occurrenceDate` sets `status: 'completed'` on `ACT#/META`
 * and retires every future occurrence — rule 3 broken by one tap, and unrecoverable in the
 * sense that matters: the days the user had already resolved are gone with it. The detail
 * screen no longer offers the control (P2-47 owns what a series *should* offer), and this is
 * the same rule held one layer down, where no future call site can route around it.
 *
 * Deliberately not applied to `undoResolution`: a bare *uncomplete* reverses this damage
 * rather than causing it, and is the only way back for a series already completed this way.
 */
function isUnscopedSeries(
  snapshot: ActivityDetail | undefined,
  scope: ActivityScope,
): boolean {
  return targetsWholeSeries(snapshot?.activity.recurrence !== undefined, scope);
}

export function useActivityActions(activityId: string): ActivityActions {
  const queryClient = useQueryClient();
  const resolutionToastId = useRef<number | undefined>(undefined);
  const retryRef = useRef<(() => void) | undefined>(undefined);

  const duplicateMutation = useMutation<Activity, Error, DuplicateActivityVariables>({
    mutationKey: activityMutationKeys.duplicate,
  });

  const deleteMutation = useMutation<
    { activityId: string },
    Error,
    DeleteActivityVariables
  >({
    mutationKey: activityMutationKeys.delete,
  });

  const completeMutation = useMutation<
    ActivityCompletionResult,
    Error,
    CompleteActivityVariables
  >({
    mutationKey: activityMutationKeys.complete,
    onSuccess: ({ activity }) => {
      retryRef.current = undefined;
      queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) =>
        previous === undefined
          ? previous
          : { ...previous, activity: activity as Activity },
      );
    },
  });

  const skipMutation = useMutation<
    ActivityCompletionResult,
    Error,
    SkipActivityVariables
  >({
    mutationKey: activityMutationKeys.skip,
  });

  const snoozeMutation = useMutation<unknown, Error, SnoozeActivityVariables>({
    mutationKey: activityMutationKeys.snooze,
  });

  const uncompleteMutation = useMutation<
    ActivityCompletionResult,
    Error,
    UncompleteActivityVariables
  >({
    mutationKey: activityMutationKeys.uncomplete,
    onSuccess: ({ activity }) => {
      retryRef.current = undefined;
      queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) =>
        previous === undefined
          ? previous
          : { ...previous, activity: activity as Activity },
      );
    },
  });

  const childCompleteMutation = useMutation<
    ActivityCompletionResult,
    Error,
    CompleteActivityVariables
  >({ mutationKey: activityMutationKeys.complete });
  const childUncompleteMutation = useMutation<
    ActivityCompletionResult,
    Error,
    UncompleteActivityVariables
  >({ mutationKey: activityMutationKeys.uncomplete });

  const failure =
    duplicateMutation.error ??
    deleteMutation.error ??
    completeMutation.error ??
    skipMutation.error ??
    snoozeMutation.error ??
    uncompleteMutation.error ??
    childCompleteMutation.error ??
    childUncompleteMutation.error;

  function resetFailures(): void {
    duplicateMutation.reset();
    deleteMutation.reset();
    completeMutation.reset();
    skipMutation.reset();
    snoozeMutation.reset();
    uncompleteMutation.reset();
    childCompleteMutation.reset();
    childUncompleteMutation.reset();
  }

  return {
    duplicate: async () => {
      const variables = { activityId, idempotencyKey: randomUUID() };
      try {
        const copy = await duplicateMutation.mutateAsync(variables);
        retryRef.current = undefined;
        return copy;
      } catch {
        retryRef.current = () => {
          void duplicateMutation.mutateAsync(variables).catch(() => undefined);
        };
        // Handled: the message is on the mutation and rendered as the banner. Rethrowing
        // would surface an unhandled rejection for a failure the UI has absorbed.
        return undefined;
      }
    },
    remove: async () => {
      const variables = { activityId, intentId: randomUUID() };
      try {
        await deleteMutation.mutateAsync(variables);
        retryRef.current = undefined;
        return true;
      } catch {
        retryRef.current = () => {
          void deleteMutation.mutateAsync(variables).catch(() => undefined);
        };
        return false;
      }
    },
    skip: async (scope) => {
      /** A bare skip on a series would retire every future occurrence. Same rule, same guard. */
      const snapshot = queryClient.getQueryData<ActivityDetail>(activityKey(activityId));
      if (isUnscopedSeries(snapshot, scope)) return false;
      const variables = {
        activityId,
        input: scopeToWire(scope),
        idempotencyKey: randomUUID(),
      };
      try {
        await skipMutation.mutateAsync(variables);
        retryRef.current = undefined;
        return true;
      } catch {
        retryRef.current = () => {
          void skipMutation.mutateAsync(variables).catch(() => undefined);
        };
        return false;
      }
    },
    snooze: async (scope, until, renderedDate) => {
      const snapshot = queryClient.getQueryData<ActivityDetail>(activityKey(activityId));
      if (isUnscopedSeries(snapshot, scope)) return false;
      /**
       * Projected before the request, like every other write on this screen. Snooze was the one
       * that waited: the detail screen moved because its own query refetched, and Today and
       * Plans kept the old time until something else refreshed them.
       */
      const restoreAgenda = projectOptimisticSnooze(queryClient, {
        activityId,
        ...scopeToWire(scope),
        date: renderedDate,
        time: until,
      });
      const variables = {
        activityId,
        input: { ...scopeToWire(scope), until },
        idempotencyKey: randomUUID(),
      };
      try {
        await snoozeMutation.mutateAsync(variables);
        retryRef.current = undefined;
        return true;
      } catch {
        restoreAgenda();
        retryRef.current = () => {
          void snoozeMutation.mutateAsync(variables).catch(() => undefined);
        };
        return false;
      }
    },
    resolvePassed: (outcome, scope, onProjected) => {
      const snapshot = queryClient.getQueryData<ActivityDetail>(activityKey(activityId));
      if (isUnscopedSeries(snapshot, scope)) return;
      let restoreAgenda = () => {};
      const original = {
        activityId,
        input: { outcome, ...scopeToWire(scope) },
        idempotencyKey: randomUUID(),
      };
      const compensation = {
        activityId,
        input: scopeToWire(scope),
        idempotencyKey: randomUUID(),
      };
      retryRef.current = () => {
        void completeMutation
          .mutateAsync(original)
          .then(() => onProjected(true))
          .catch(() => undefined);
      };

      startUndoable({
        /**
         * `revert` restores this snapshot, so `apply` has to have moved something for the undo
         * to mean anything. It did not: it only dismissed the passed-plan prompt, which left
         * the detail screen showing its completion button unchanged after a successful
         * completion — the write landed and the screen denied it.
         */
        apply: () => {
          onProjected(true);
          restoreAgenda = projectOptimisticCompletion(queryClient, {
            activityId,
            completed: true,
            ...scopeToWire(scope),
          });
          /**
           * **Only a one-off moves the Activity.** Completing an *occurrence* writes an
           * `Occurrence` override and leaves `ACT#/META` untouched (`data-model.md` §4.5), so
           * projecting a completed status onto the series here would be the client telling the
           * same lie the repository layer is forbidden from telling. The occurrence's own state
           * is projected into the agenda by `agendaCache`, which is where occurrence scope
           * lives.
           */
          if (scope.kind === 'occurrence') return;
          queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) =>
            previous === undefined
              ? previous
              : {
                  ...previous,
                  activity: { ...previous.activity, status: 'completed', outcome },
                },
          );
        },
        revert: () => {
          onProjected(false);
          restoreAgenda();
          if (snapshot !== undefined)
            queryClient.setQueryData(activityKey(activityId), snapshot);
        },
        restorePosition: () => {},
        request: () => completeMutation.mutateAsync(original),
        compensate: () => uncompleteMutation.mutateAsync(compensation),
        originalIntent: {
          intentId: original.idempotencyKey,
          mutationKey: activityMutationKeys.complete,
          variables: original,
          entityId: activityId,
        },
        inverseIntent: {
          intentId: compensation.idempotencyKey,
          mutationKey: activityMutationKeys.uncomplete,
          variables: compensation,
          entityId: activityId,
        },
        toast: {
          showUndo: (toast) => {
            const id = useToast.getState().showUndo(toast);
            resolutionToastId.current = id;
            return id;
          },
          failUndo: useToast.getState().failUndo,
        },
        message: OUTCOME_RECORDED,
        failureMessage: "Couldn't record that outcome.",
        compensationFailureMessage: "Couldn't undo that outcome.",
      });
    },
    undoResolution: (scope, onProjected) => {
      const toastId = resolutionToastId.current;
      const activeToast = useToast.getState().current;

      /**
       * A fresh completion may still be in flight when the optimistic screen reveals Undo.
       * Route that press through `startUndoable`'s existing coordinator: it reverts locally
       * now, waits for Complete to succeed, then sends the compensating Uncomplete. Sending
       * both POSTs concurrently would let network order decide the final state.
       */
      if (
        toastId !== undefined &&
        activeToast?.id === toastId &&
        activeToast.kind === 'undo'
      ) {
        resolutionToastId.current = undefined;
        // `startUndoable`'s own `revert`/`apply` already drive the caller's projection through
        // the `onProjected` it was given at completion time, including a failed compensation.
        useToast.getState().undo(toastId);
        return;
      }

      // The toast expired or this detail loaded in a completed state. Use the permanent path
      // without dismissing an unrelated toast that may have replaced the completion toast.
      resolutionToastId.current = undefined;
      const snapshot = queryClient.getQueryData<ActivityDetail>(activityKey(activityId));
      const restoredStatus =
        snapshot?.activity.schedule?.date === undefined ? 'saved' : 'scheduled';
      const restoreAgenda = projectOptimisticCompletion(queryClient, {
        activityId,
        completed: false,
        restoredStatus,
        ...scopeToWire(scope),
      });

      /**
       * Projected before the request, not after it.
       *
       * The row on Today flips the instant you tap it, because the agenda path is optimistic.
       * Waiting for the round trip here made the same undo feel a beat slower on the detail
       * screen than on the row it came from — measured at ~820 ms locally, and worse on a real
       * network. The response still lands and reconciles; this only decides what the screen
       * shows while it is in flight.
       *
       * A recurring occurrence is left alone: its state lives on the `Occurrence`, not on the
       * series (`data-model.md` §4.5).
       */
      if (scope.kind === 'activity' && snapshot !== undefined) {
        queryClient.setQueryData<ActivityDetail>(activityKey(activityId), {
          ...snapshot,
          activity: {
            ...snapshot.activity,
            status: restoredStatus,
          },
        });
      }

      /**
       * An occurrence's resolution is not readable from the series it belongs to, so the
       * caller holds that state and this is the only thing that can move it. The detail cache
       * restore above is enough for a one-off and says nothing at all for an occurrence.
       */
      onProjected?.(false);

      const variables = {
        activityId,
        input: scopeToWire(scope),
        idempotencyKey: randomUUID(),
      };
      retryRef.current = () => {
        void uncompleteMutation
          .mutateAsync(variables)
          .then(() => onProjected?.(false))
          .catch(() => undefined);
      };
      void uncompleteMutation.mutateAsync(variables).catch(() => {
        // Put the completion back: the screen must not claim an undo the server refused.
        // The message is on the mutation and renders as the screen's banner.
        if (snapshot !== undefined)
          queryClient.setQueryData(activityKey(activityId), snapshot);
        restoreAgenda();
        onProjected?.(true);
      });
    },
    setChildCompletion: async (child, completed) => {
      if (child.isRecurring) return false;
      const intentId = randomUUID();
      const completeVariables: CompleteActivityVariables = {
        activityId: child.activityId,
        input: { outcome: 'done' },
        idempotencyKey: intentId,
      };
      const uncompleteVariables: UncompleteActivityVariables = {
        activityId: child.activityId,
        input: {},
        idempotencyKey: intentId,
      };
      const applyResult = (result: ActivityCompletionResult) => {
        queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) => {
          if (previous?.children === undefined) return previous;
          return {
            ...previous,
            children: previous.children.map((entry) =>
              entry.activityId === child.activityId
                ? { ...entry, status: result.activity.status }
                : entry,
            ),
          };
        });
      };
      try {
        const result = completed
          ? await childCompleteMutation.mutateAsync(completeVariables)
          : await childUncompleteMutation.mutateAsync(uncompleteVariables);
        retryRef.current = undefined;
        applyResult(result);
        return true;
      } catch {
        retryRef.current = () => {
          const retry = completed
            ? childCompleteMutation.mutateAsync(completeVariables)
            : childUncompleteMutation.mutateAsync(uncompleteVariables);
          void retry.then(applyResult).catch(() => undefined);
        };
        return false;
      }
    },
    isBusy:
      duplicateMutation.isPending ||
      deleteMutation.isPending ||
      completeMutation.isPending ||
      skipMutation.isPending ||
      snoozeMutation.isPending ||
      uncompleteMutation.isPending ||
      childCompleteMutation.isPending ||
      childUncompleteMutation.isPending,
    isCompleting: completeMutation.isPending,
    isUndoing: uncompleteMutation.isPending,
    errorMessage:
      failure === null || failure === undefined
        ? undefined
        : describeActionFailure(failure),
    errorRequestId: failure instanceof ApiError ? failure.requestId : undefined,
    retryError: () => {
      const retry = retryRef.current;
      resetFailures();
      retry?.();
    },
    dismissError: () => {
      retryRef.current = undefined;
      resetFailures();
    },
  };
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
