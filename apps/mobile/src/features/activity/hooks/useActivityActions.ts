import { type ChangeTarget, changeActivityKind } from '@od/shared';
import {
  ApiError,
  completeActivity,
  deleteActivity,
  duplicateActivity,
  uncompleteActivity,
} from '@od/shared/client';
import type { PatchActivityInput } from '@od/shared/schemas';
import type { Activity, ActivityDetail, ActivityOutcome } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { apiClient } from '@/lib/apiClient';
import { startUndoable } from '@/lib/startUndoable';
import { useToast } from '@/stores/toast';
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
export interface ActivityActions {
  duplicate: () => Promise<Activity | undefined>;
  remove: () => Promise<boolean>;
  resolvePassed: (
    outcome: ActivityOutcome,
    occurrenceDate: string | undefined,
    onProjected: (resolved: boolean) => void,
  ) => void;
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

  const completeMutation = useMutation({
    mutationFn: ({
      outcome,
      occurrenceDate,
      idempotencyKey,
    }: {
      outcome: ActivityOutcome;
      occurrenceDate?: string;
      idempotencyKey: string;
    }) =>
      completeActivity(
        apiClient,
        activityId,
        { outcome, ...(occurrenceDate === undefined ? {} : { occurrenceDate }) },
        idempotencyKey,
      ),
    onSuccess: ({ activity }) => {
      queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) =>
        previous === undefined
          ? previous
          : { ...previous, activity: activity as Activity },
      );
      void queryClient.invalidateQueries({ queryKey: ['agenda'] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
    retry: false,
    networkMode: 'always',
  });

  const uncompleteMutation = useMutation({
    mutationFn: ({
      occurrenceDate,
      idempotencyKey,
    }: {
      occurrenceDate?: string;
      idempotencyKey: string;
    }) =>
      uncompleteActivity(
        apiClient,
        activityId,
        occurrenceDate === undefined ? {} : { occurrenceDate },
        idempotencyKey,
      ),
    onSuccess: ({ activity }) => {
      queryClient.setQueryData<ActivityDetail>(activityKey(activityId), (previous) =>
        previous === undefined
          ? previous
          : { ...previous, activity: activity as Activity },
      );
      void queryClient.invalidateQueries({ queryKey: ['agenda'] });
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
    },
    retry: false,
    networkMode: 'always',
  });

  const failure =
    duplicateMutation.error ??
    deleteMutation.error ??
    completeMutation.error ??
    uncompleteMutation.error;

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
    resolvePassed: (outcome, occurrenceDate, onProjected) => {
      const snapshot = queryClient.getQueryData<ActivityDetail>(activityKey(activityId));
      const original = {
        outcome,
        ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
        idempotencyKey: randomUUID(),
      };
      const compensation = {
        ...(occurrenceDate === undefined ? {} : { occurrenceDate }),
        idempotencyKey: randomUUID(),
      };

      startUndoable({
        apply: () => onProjected(true),
        revert: () => {
          onProjected(false);
          if (snapshot !== undefined)
            queryClient.setQueryData(activityKey(activityId), snapshot);
        },
        restorePosition: () => {},
        request: () => completeMutation.mutateAsync(original),
        compensate: () => uncompleteMutation.mutateAsync(compensation),
        toast: {
          showUndo: useToast.getState().showUndo,
          failUndo: useToast.getState().failUndo,
        },
        message: 'Outcome recorded',
        failureMessage: "Couldn't record that outcome.",
        compensationFailureMessage: "Couldn't undo that outcome.",
      });
    },
    isBusy:
      duplicateMutation.isPending ||
      deleteMutation.isPending ||
      completeMutation.isPending ||
      uncompleteMutation.isPending,
    errorMessage:
      failure === null || failure === undefined ? undefined : describe(failure),
    dismissError: () => {
      duplicateMutation.reset();
      deleteMutation.reset();
      completeMutation.reset();
      uncompleteMutation.reset();
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
