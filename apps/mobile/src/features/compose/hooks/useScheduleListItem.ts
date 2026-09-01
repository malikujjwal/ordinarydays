import type { CreationTarget } from '@od/shared/client';
import { ApiError, scheduleListItem } from '@od/shared/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type DraftFields,
  toScheduleListItemInput,
} from '@/features/compose/model/targets';
import { apiClient } from '@/lib/apiClient';
import { newLocalId } from '@/lib/localIds';
import { listMutationKeys } from '@/lib/mutationKeys';
import { LISTS_KEY } from '@/lib/queryKeys';
import { type DraftAudience, useComposeDraft } from '@/stores/composeDraft';

/**
 * `POST /v1/lists/:id/items/:itemId/schedule` from the `Plan this item` form (P3-34).
 *
 * The web arm of the bridge. Shape and error copy mirror `useCreateActivity` — same banner,
 * same field errors, same idempotency discipline via the draft store's `takeIdempotencyKey`
 * and `takeActivityId` — but the write is the list-scoped bridge endpoint, whose transaction
 * also writes the caller's `viewerLink`. The `mutationKey` matches the native durable intent's
 * so the process-wide `MutationCache` treats both worlds' writes alike.
 *
 * Reminder ids are minted here, at the save boundary, with the same `rem_` generator native
 * persists before its intent (§P3-13). The transport retries under the one idempotency key,
 * so a retried body carries the same ids.
 */

export interface ScheduleListItemResult {
  save: (
    target: CreationTarget,
    fields: DraftFields,
    timezone: string,
  ) => Promise<boolean>;
  isSaving: boolean;
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  fieldErrors: Record<string, string>;
  dismissError: () => void;
}

function describe(error: unknown): { message: string; requestId?: string } {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      return { message: 'Something went wrong.', requestId: error.requestId };
    }
    if (error.code === 'not_found') {
      return { message: "This isn't here any more.", requestId: error.requestId };
    }
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't save this." };
}

function toFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.details === undefined) return {};
  const out: Record<string, string> = {};
  for (const detail of error.details) out[detail.path] = detail.message;
  return out;
}

interface ScheduleVariables {
  readonly listId: string;
  readonly itemId: string;
  readonly input: Parameters<typeof scheduleListItem>[3];
  readonly idempotencyKey: string;
}

export function useScheduleListItem(): ScheduleListItemResult {
  const queryClient = useQueryClient();
  const bridge = useComposeDraft((s) => s.bridge);
  const audience = useComposeDraft((s) => s.audience);
  const takeIdempotencyKey = useComposeDraft((s) => s.takeIdempotencyKey);
  const takeActivityId = useComposeDraft((s) => s.takeActivityId);
  const [localError, setLocalError] = useState<Error>();

  const mutation = useMutation({
    mutationKey: listMutationKeys.itemSchedule,
    mutationFn: ({ listId, itemId, input, idempotencyKey }: ScheduleVariables) =>
      scheduleListItem(apiClient, listId, itemId, input, idempotencyKey),
  });

  const error = localError ?? (mutation.error === null ? undefined : mutation.error);
  const failure = error === undefined ? undefined : describe(error);

  return {
    save: async (target, fields, timezone) => {
      try {
        setLocalError(undefined);
        if (bridge === undefined || target.objectKind !== 'plan') {
          throw new Error('Plan this item requires a bridge source and a Plan target.');
        }
        const chosenAudience: DraftAudience | undefined = audience;
        if (chosenAudience === undefined) {
          throw new Error('Plan this item requires the explicitly tapped audience.');
        }
        const input = toScheduleListItemInput(
          target,
          fields,
          timezone,
          takeActivityId(),
          chosenAudience,
          () => newLocalId('rem'),
        );
        if (input === undefined) {
          throw new Error('The bridge request could not be built from this draft.');
        }
        await mutation.mutateAsync({
          listId: bridge.listId,
          itemId: bridge.itemId,
          input,
          idempotencyKey: takeIdempotencyKey(),
        });
        /*
         * The caller's `viewerLink` changed under the open list, so its cached pages are
         * stale. Awaited before the modal closes; the `MutationCache` covers the
         * activity/agenda side through `changesActivityLists`.
         */
        await queryClient.invalidateQueries({ queryKey: LISTS_KEY });
        return true;
      } catch (error) {
        setLocalError(error instanceof Error ? error : new Error(String(error)));
        // Swallowed on purpose: rendered as the banner, like the create hook's failures.
        return false;
      }
    },
    isSaving: mutation.isPending,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    fieldErrors: toFieldErrors(error),
    dismissError: () => {
      setLocalError(undefined);
      mutation.reset();
    },
  };
}
