import {
  ApiError,
  convertRecurrence,
  type createReminder,
  type deleteReminder,
  getActivity,
  patchActivity,
  type scheduleActivity,
} from '@od/shared/client';
import type { PatchActivityInput, ScheduleActivityInput } from '@od/shared/schemas';
import type {
  Activity,
  ActivityDetail,
  ActivityDetailTarget,
  OccurrenceDetailProjection,
  Reminder,
} from '@od/shared/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import {
  CONFLICT_MESSAGE,
  droppedMessage,
  resolveConflict,
} from '@/features/activity/model/conflict';
import { usePendingIntents } from '@/hooks/usePendingIntents';
import { apiClient } from '@/lib/apiClient';
import {
  type ConvertRecurrenceVariables,
  type PatchActivityVariables,
  patchChangeNames,
  type ReminderCreateVariables,
  type ReminderDeleteVariables,
  type ScheduleActivityVariables,
} from '@/lib/mutationDefaults';
import { activityMutationKeys } from '@/lib/mutationKeys';
import {
  type PendingActivityDetail,
  pendingActivityDetailFromIntent,
} from '@/lib/pendingActivity';
import { activityDetailKey, activityKey } from '@/lib/queryKeys';

/**
 * The activity detail read and its in-place edits (P1-26).
 *
 * One `useQuery` for the screen and one `useMutation` for every field, because editing is in
 * place: text commits on blur, pickers commit on selection, and each is its own `PATCH` with
 * `If-Match` (`activities.md` §6.1). There is no edit mode and no per-field Save button, so
 * there is no "form state" to hold — the query's data *is* the state.
 */

/**
 * Re-exported from `lib/queryKeys`, which now owns it — `lib/agendaCache` needs the same key
 * and a key is not a hook. Kept here so the screens and tests that already read it from the
 * hook module do not all have to change to say the same thing.
 */
export { activityKey };

export interface ActivityDetailView {
  status: 'pending' | 'success' | 'error';
  detail?: ActivityDetail | PendingActivityDetail;
  /** `interaction-contract.md` §5.3 copy for the screen-level failure. */
  message?: string;
  requestId?: string;
  refetch: () => void;
  isSaving: boolean;
  /** Commits one field and reports whether the server accepted it. */
  patch: (input: PatchActivityInput) => Promise<boolean>;
  /** Sole scheduling mutation; its enqueue-time key is persisted with mutation variables. */
  schedule: (input: ScheduleActivityInput) => Promise<boolean>;
  /** Atomic Does-not-repeat conversion for one explicitly selected occurrence. */
  convertToOneOff: (selectedDate: string) => Promise<boolean>;
  /** Adds one caller-owned reminder through P2-16's replay-safe mutation. */
  addReminder: (offsetMinutes: number) => Promise<boolean>;
  /** Removes one caller-owned reminder by its opaque id. */
  removeReminder: (reminderId: string) => Promise<boolean>;
  isSavingReminder: boolean;
  reminderError?: string;
  /** The conflict banner, present only after a 409. Dismissed by `acknowledgeConflict`. */
  conflict?: { message: string; dropped?: string };
  acknowledgeConflict: () => void;
  /** A failed edit, shown inline; the field keeps the user's text (§5.3). */
  editError?: string;
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    if (error.status === 404) return { message: "This isn't here any more." };
    if (error.status === 403) {
      return { message: 'Only the person who made this plan can change that.' };
    }
    if (error.status >= 500) {
      return { message: 'Something went wrong.', requestId: error.requestId };
    }
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't load this." };
}

export function useActivityDetail(
  targetInput: ActivityDetailTarget | string,
): ActivityDetailView {
  const target: ActivityDetailTarget =
    typeof targetInput === 'string'
      ? { kind: 'activity', activityId: targetInput }
      : targetInput;
  const activityId = target.activityId;
  const queryKey = activityDetailKey(target);
  const queryClient = useQueryClient();
  const pendingIntents = usePendingIntents();
  const pendingDetail = pendingIntents
    .map((intent) => pendingActivityDetailFromIntent(intent, target))
    .find((detail) => detail !== undefined);
  const [conflict, setConflict] = useState<ActivityDetailView['conflict']>(undefined);
  const [editError, setEditError] = useState<string | undefined>(undefined);
  const [reminderError, setReminderError] = useState<string | undefined>(undefined);

  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getActivity(apiClient, target, signal),
    // A pending create has no server row to read. Its durable intent is the detail source.
    enabled: pendingDetail === undefined,
    /**
     * `always`, overriding the app-wide `offlineFirst`, for the reason written out in
     * `useHealth`: under `offlineFirst` a network-class failure pauses the query rather than
     * failing it, and `refetch()` is paused with it — so `Try again` would do nothing on
     * exactly the failure the user is looking at.
     */
    networkMode: 'always',
    // The transport already retries a 5xx three times with jittered backoff.
    retry: false,
  });

  const mutation = useMutation<Activity, Error, PatchActivityVariables>({
    mutationKey: activityMutationKeys.patch,
    mutationFn: async ({ input, ifMatch }) => {
      const current = queryClient.getQueryData<ActivityDetail>(queryKey);
      if (current === undefined) throw new Error('No activity loaded to patch.');

      try {
        return await patchActivity(apiClient, activityId, input, ifMatch);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409) throw error;

        /**
         * §6.1's conflict path, in full. Refetch, compare three ways, re-apply what nobody
         * else touched, and name what was dropped. The refetched activity is written to the
         * cache first so the screen shows the other person's version even if the re-apply
         * itself then fails.
         */
        const fresh = await getActivity(apiClient, target);
        queryClient.setQueryData(queryKey, fresh);

        const resolution = resolveConflict(current.activity, fresh.activity, input);
        setConflict({
          message: CONFLICT_MESSAGE,
          ...(droppedMessage(resolution.dropped) === undefined
            ? {}
            : { dropped: droppedMessage(resolution.dropped) as string }),
        });

        if (resolution.reapply === undefined) return fresh.activity;
        return await patchActivity(
          apiClient,
          activityId,
          resolution.reapply,
          resolution.ifMatch,
        );
      }
    },
    onSuccess: (activity: Activity) => {
      setEditError(undefined);
      // Write the server's version back rather than the optimistic one: `updatedAt` has
      // moved, and the next edit's `If-Match` is built from it.
      queryClient.setQueryData<ActivityDetail>(
        queryKey,
        (previous: ActivityDetail | undefined) =>
          previous === undefined ? previous : { ...previous, activity },
      );
    },
    onError: (error: unknown) => setEditError(describe(error).message),
  });

  const scheduleMutation = useMutation<
    Awaited<ReturnType<typeof scheduleActivity>>,
    Error,
    ScheduleActivityVariables
  >({
    mutationKey: activityMutationKeys.schedule,
    onSuccess: (result) => {
      const activity = result.activity as Activity;
      setEditError(undefined);
      queryClient.setQueryData<ActivityDetail>(
        queryKey,
        (previous: ActivityDetail | undefined) =>
          previous === undefined
            ? previous
            : {
                ...previous,
                activity,
                ...(result.occurrence === undefined
                  ? {}
                  : { occurrence: result.occurrence as OccurrenceDetailProjection }),
              },
      );
    },
    onError: (error: unknown) => setEditError(describe(error).message),
  });

  const convertMutation = useMutation<Activity, Error, ConvertRecurrenceVariables>({
    mutationKey: activityMutationKeys.convertRecurrence,
    mutationFn: ({ input, idempotencyKey }) =>
      convertRecurrence(apiClient, activityId, input.selectedDate, idempotencyKey),
    onSuccess: (activity) => {
      setEditError(undefined);
      const converted: ActivityDetail = {
        ...(queryClient.getQueryData<ActivityDetail>(queryKey) ?? {
          reminders: [],
        }),
        activity,
      };
      delete converted.occurrence;
      queryClient.setQueryData(queryKey, converted);
      queryClient.setQueryData(activityKey(activityId), converted);
    },
    onError: (error: unknown) => setEditError(describe(error).message),
  });

  const reminderCreateMutation = useMutation<
    Awaited<ReturnType<typeof createReminder>>,
    Error,
    ReminderCreateVariables
  >({
    mutationKey: activityMutationKeys.reminderCreate,
    onSuccess: (reminder) => {
      setReminderError(undefined);
      queryClient.setQueryData<ActivityDetail>(
        queryKey,
        (previous: ActivityDetail | undefined) =>
          previous === undefined
            ? previous
            : { ...previous, reminders: [...previous.reminders, reminder] },
      );
    },
    onError: (error: unknown) => setReminderError(describe(error).message),
  });

  const reminderDeleteMutation = useMutation<
    Awaited<ReturnType<typeof deleteReminder>>,
    Error,
    ReminderDeleteVariables
  >({
    mutationKey: activityMutationKeys.reminderDelete,
    onSuccess: ({ reminderId }) => {
      setReminderError(undefined);
      queryClient.setQueryData<ActivityDetail>(
        queryKey,
        (previous: ActivityDetail | undefined) =>
          previous === undefined
            ? previous
            : {
                ...previous,
                reminders: previous.reminders.filter(
                  (reminder: Reminder) => reminder.reminderId !== reminderId,
                ),
              },
      );
    },
    onError: (error: unknown) => setReminderError(describe(error).message),
  });

  const failure =
    pendingDetail !== undefined || query.error === null
      ? undefined
      : describe(query.error);

  return {
    status: pendingDetail === undefined ? query.status : 'success',
    refetch: () => {
      if (pendingDetail === undefined) void query.refetch();
    },
    isSaving:
      mutation.isPending || scheduleMutation.isPending || convertMutation.isPending,
    isSavingReminder:
      reminderCreateMutation.isPending || reminderDeleteMutation.isPending,
    patch: async (input) => {
      try {
        const current = queryClient.getQueryData<ActivityDetail>(queryKey);
        if (current === undefined) return false;
        await mutation.mutateAsync({
          activityId,
          input,
          ifMatch: current.activity.updatedAt,
          changeNames: patchChangeNames(input),
        });
        return true;
      } catch {
        // Handled: the message is already on `editError` and rendered inline. Rethrowing
        // would surface an unhandled rejection for a failure the UI has fully absorbed.
        return false;
      }
    },
    schedule: async (input) => {
      try {
        await scheduleMutation.mutateAsync({
          activityId,
          input,
          idempotencyKey: randomUUID(),
        });
        return true;
      } catch {
        // The inline error state owns the failure; the enqueue-time key stays in variables.
        return false;
      }
    },
    convertToOneOff: async (selectedDate) => {
      try {
        await convertMutation.mutateAsync({
          activityId,
          input: { selectedDate },
          idempotencyKey: randomUUID(),
        });
        return true;
      } catch {
        return false;
      }
    },
    addReminder: async (offsetMinutes) => {
      try {
        await reminderCreateMutation.mutateAsync({
          activityId,
          input: { offsetMinutes },
          idempotencyKey: randomUUID(),
        });
        return true;
      } catch {
        return false;
      }
    },
    removeReminder: async (reminderId) => {
      try {
        await reminderDeleteMutation.mutateAsync({ activityId, reminderId });
        return true;
      } catch {
        return false;
      }
    },
    acknowledgeConflict: () => setConflict(undefined),
    ...(pendingDetail === undefined
      ? query.data === undefined
        ? {}
        : { detail: query.data }
      : { detail: pendingDetail }),
    ...(failure === undefined
      ? {}
      : {
          message: failure.message,
          ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        }),
    ...(conflict === undefined ? {} : { conflict }),
    ...(editError === undefined ? {} : { editError }),
    ...(reminderError === undefined ? {} : { reminderError }),
  };
}
