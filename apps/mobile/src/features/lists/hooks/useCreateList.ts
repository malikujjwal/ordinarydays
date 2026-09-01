import { ApiError, createList } from '@od/shared/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { apiClient } from '@/lib/apiClient';
import { listMutationKeys } from '@/lib/mutationKeys';
import { LISTS_KEY } from './keys';

/**
 * `Create list` on **web**: one online mutation through `POST /v1/lists` (§P3-26).
 *
 * The native file beside this one accepts the same confirmation into SQLite first and syncs it
 * afterwards. Metro resolves `.native.ts` ahead of this, so the sheet imports one name and
 * neither platform knows the other exists — the `useLists` pattern, unchanged.
 *
 * ## What differs, and why it is not a shortcut
 *
 * Web mints the **key**, native mints the **id**. A browser tab is closed rather than
 * backgrounded, so there is no queue to drain and therefore nothing to name before the server
 * does (ADR-024's web rule, kept by ADR-055). The `Idempotency-Key` still matters: a save that
 * succeeded but lost its response resolves to one list rather than two when the transport
 * retries it.
 */
export interface CreateListResult {
  /**
   * Writes the list, and answers with its id so the caller can continue into it.
   *
   * Takes the **tapped** style's key and the visible title. Not a draft, not free text: there
   * is no argument through which a title could influence the style. `sourceActivityId` is
   * P3-39's Plan relationship — it comes from the plan whose labelled `Add list` opened the
   * sheet, never from anything typed, and the server forces the copied slot to `null` for it.
   */
  create: (
    templateKey: string,
    title: string,
    options?: { sourceActivityId?: string },
  ) => Promise<string | undefined>;
  isCreating: boolean;
  /** `interaction-contract.md` §5.3 copy. The step stays open behind it. */
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  dismissError: () => void;
}

/**
 * §5.3's copy, never the exception's own text for a 5xx: `Failed to fetch` describes a socket.
 * A 4xx that came back through the envelope *is* the server's user-facing sentence.
 */
export function describeCreateFailure(error: unknown): {
  message: string;
  requestId?: string;
} {
  if (error instanceof ApiError) {
    if (error.status >= 500) {
      return { message: 'Something went wrong.', requestId: error.requestId };
    }
    return { message: error.message, requestId: error.requestId };
  }
  return { message: "Couldn't save this." };
}

export function useCreateList(): CreateListResult {
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>();

  const mutation = useMutation({
    // The persisted wire tag: the process-wide MutationCache seam reads it to refresh the
    // source Plan's detail on a sourced create (P3-39) — see `refreshActivityDetails`.
    mutationKey: listMutationKeys.create,
    mutationFn: ({
      templateKey,
      title,
      sourceActivityId,
    }: {
      templateKey: string;
      title: string;
      sourceActivityId?: string;
    }) =>
      // `expo-crypto`, not `crypto.randomUUID`: the latter is absent from some Hermes builds,
      // and an idempotency key is the wrong place to find that out.
      createList(
        apiClient,
        {
          title,
          templateKey,
          ...(sourceActivityId === undefined ? {} : { sourceActivityId }),
        },
        randomUUID(),
      ),
  });

  const failure = error === undefined ? undefined : describeCreateFailure(error);

  return {
    create: async (templateKey, title, options) => {
      try {
        setError(undefined);
        const list = await mutation.mutateAsync({
          templateKey,
          title,
          ...(options?.sourceActivityId === undefined
            ? {}
            : { sourceActivityId: options.sourceActivityId }),
        });
        // The index is a separate query and the sheet closes onto it; without this the new
        // list is missing from the screen the user is returned to.
        await queryClient.invalidateQueries({ queryKey: LISTS_KEY });
        return list.listId;
      } catch (caught) {
        setError(caught);
        // Swallowed on purpose: the failure is rendered in the sheet, so rethrowing would
        // surface an unhandled rejection for something the UI has fully handled.
        return undefined;
      }
    },
    isCreating: mutation.isPending,
    errorMessage: failure?.message,
    errorRequestId: failure?.requestId,
    dismissError: () => {
      setError(undefined);
      mutation.reset();
    },
  };
}
