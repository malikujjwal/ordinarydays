import { ApiError, type CreationTarget } from '@od/shared/client';
import type { Activity } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type DraftFields,
  toCreateActivityInput,
} from '@/features/compose/model/targets';
import type { CreateActivityVariables } from '@/lib/mutationDefaults';
import { activityMutationKeys } from '@/lib/mutationKeys';
import { ACTIVITIES_KEY } from '@/lib/queryKeys';
import { useComposeDraft } from '@/stores/composeDraft';

/**
 * `POST /v1/activities` from the compose form (P1-24, `activities.md` §2.5).
 *
 * One write per save. The `Idempotency-Key` comes from the draft store's
 * `takeIdempotencyKey`, which generates it at the public save boundary and hands back the same key on
 * every retry until the draft changes — the client's transport then retries a 5xx or a
 * network fault under that key, so a save that succeeded on the server but lost its response
 * resolves to one Activity rather than two.
 */

export interface CreateActivityResult {
  save: (
    target: CreationTarget,
    fields: DraftFields,
    /** The zone the wall-clock schedule is anchored in, supplied by the route. */
    timezone: string,
  ) => Promise<Activity | undefined>;
  isSaving: boolean;
  /** `interaction-contract.md` §5.3 copy for the banner. The draft stays open behind it. */
  errorMessage: string | undefined;
  /** Shown in small text beside the banner so a support message can name it. */
  errorRequestId: string | undefined;
  /** Per-field messages from a `validation_failed`, keyed by the path they name. */
  fieldErrors: Record<string, string>;
  dismissError: () => void;
}

/**
 * Maps a failure onto the copy in `interaction-contract.md` §5.3.
 *
 * Never the exception's own text for a 5xx: `Failed to fetch` describes a socket. A 4xx that
 * came back through the envelope *is* the server's user-facing sentence, so it is used.
 */
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

/** `details[]` entries become one message per field path, for the inline errors on the form. */
function toFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.details === undefined) return {};
  const out: Record<string, string> = {};
  for (const detail of error.details) out[detail.path] = detail.message;
  return out;
}

export function useCreateActivity(): CreateActivityResult {
  const takeIdempotencyKey = useComposeDraft((s) => s.takeIdempotencyKey);
  const queryClient = useQueryClient();

  const mutation = useMutation<Activity, Error, CreateActivityVariables>({
    mutationKey: activityMutationKeys.create,
    /**
     * **The write is not finished until the lists know about it.**
     *
     * Without this the save succeeds, the modal closes, the toast names where it landed — and
     * the activity is not there. `queryClient`'s `staleTime` is 60 s and the Plans screen stays
     * mounted behind the modal, so nothing refetches: the user is told it worked and shown a
     * list that says otherwise, for a minute. Found by P1-29's E2E flow, which is the first
     * thing in this repository that could have found it; every layer below passes because
     * every layer below is correct in isolation.
     *
     * The **root** key, not one stage: a new activity lands in whichever of the four its date
     * and kind imply, and this hook has no business working out which.
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ACTIVITIES_KEY });
    },
  });

  const failure = mutation.error === null ? undefined : describe(mutation.error);

  return {
    save: async (target, fields, timezone) => {
      try {
        const input = toCreateActivityInput(target, fields, timezone);
        if (input === undefined) {
          throw new Error('A List item is not created through POST /v1/activities.');
        }
        return await mutation.mutateAsync({
          input,
          idempotencyKey: takeIdempotencyKey(),
        });
      } catch {
        // Swallowed on purpose: the error is already on `mutation.error` and is rendered as
        // the banner. Rethrowing here would surface an unhandled rejection for a failure the
        // UI has fully handled.
        return undefined;
      }
    },
    isSaving: mutation.isPending,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    fieldErrors: toFieldErrors(mutation.error),
    dismissError: () => mutation.reset(),
  };
}
