import { ApiError, addIngredientsToList } from '@od/shared/client';
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useRef } from 'react';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { INGREDIENTS_CHANGED } from '@/lib/destinationCopy';
import { activityKey, LISTS_KEY } from '@/lib/queryKeys';
import { getActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';

/**
 * P3-17's activity-scoped write behind the meal detail's `Add n to <list>` (P3-43, §5.3):
 * the selected stable `ing_` ids to one named destination, as one request that is accepted
 * or refused whole. A refusal (the meal's rows changed under the selection, 409) is the
 * `Reopen` toast; any other failure offers `Retry` with the same variables.
 *
 * The hook, not the section, owns the mutation (`coding-standards.md` §8.2): the component
 * renders the picker and hands the selection here.
 *
 * ## The rows flip to `Added` from whichever store the screen reads (device report, 2026-09-11)
 *
 * On iOS the detail screen reads the Activity from SQLite (ADR-057), not from React Query, so
 * invalidating query keys alone left every row unmarked: the write succeeded, the rows never
 * said `Added`, and the user added the same ingredients twice more. After success the native
 * Activity is re-pulled through the sync engine's own `pullActivity` — the owner the detail
 * hook and the photo delete already use, which installs the canonical row the screen is
 * subscribed to — and the destination list's projection is refreshed through `pullListDetail`
 * without holding the button on it. Web keeps its query invalidation. The selection clears
 * only once the Activity refresh has landed, and the mutation stays pending until then, so
 * there is no window in which the rows look unadded while the add action is live.
 *
 * A second tap while one request is in flight is dropped here, synchronously, rather than
 * relying on the disabled button's next render.
 */
export interface AddIngredientsInput {
  listId: string;
  ingredientIds: readonly string[];
}

export interface AddIngredientsController {
  readonly mutate: (input: AddIngredientsInput) => void;
  readonly isPending: boolean;
}

export function useAddIngredients(
  activityId: string,
  options: { onSettledSelection: () => void },
): AddIngredientsController {
  const queryClient = useQueryClient();
  const { onSettledSelection } = options;
  const inFlight = useRef(false);

  const add = useMutation({
    mutationFn: (input: AddIngredientsInput) =>
      addIngredientsToList(
        apiClient,
        activityId,
        {
          listId: input.listId,
          ingredients: input.ingredientIds.map((ingredientId) => ({ ingredientId })),
        },
        randomUUID(),
      ),
    onSuccess: async (_result, input) => {
      await refreshAfterAdd(queryClient, activityId, input.listId);
      onSettledSelection();
    },
    onError: (error: unknown, variables) => {
      const changed = error instanceof ApiError && error.status === 409;
      const failure = describeApiFailure(error, "Couldn't add those ingredients.");
      useToast.getState().show({
        message: changed ? INGREDIENTS_CHANGED : failure.message,
        tone: 'error',
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        action: changed
          ? {
              label: 'Reopen',
              onPress: () => {
                onSettledSelection();
                void refreshAfterAdd(queryClient, activityId, undefined);
              },
            }
          : { label: 'Retry', onPress: () => mutate(variables) },
      });
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  function mutate(input: AddIngredientsInput): void {
    if (inFlight.current) return;
    inFlight.current = true;
    add.mutate(input);
  }

  return { mutate, isPending: add.isPending };
}

/**
 * Re-reads the meal (and the destination list, when there is one) into the store each
 * platform renders from. A failed native pull falls back to the engine's ordinary wake,
 * exactly as the photo delete does; the write itself has already succeeded and is not retried.
 */
async function refreshAfterAdd(
  queryClient: QueryClient,
  activityId: string,
  listId: string | undefined,
): Promise<void> {
  const native = getActiveNativeState();
  if (native !== undefined) {
    const sync = native.sync;
    const pullListDetail = sync.pullListDetail;
    if (listId !== undefined && pullListDetail !== undefined) {
      void pullListDetail.call(sync, listId).catch(() => undefined);
    }
    try {
      await sync.pullActivity({ kind: 'activity', activityId });
    } catch {
      sync.request('accepted-action');
    }
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: activityKey(activityId) }),
    queryClient.invalidateQueries({ queryKey: LISTS_KEY }),
  ]);
}
