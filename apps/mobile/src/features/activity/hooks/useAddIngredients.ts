import { ApiError, addIngredientsToList } from '@od/shared/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { INGREDIENTS_CHANGED } from '@/lib/destinationCopy';
import { activityKey, LISTS_KEY } from '@/lib/queryKeys';
import { useToast } from '@/stores/toast';

/**
 * P3-17's activity-scoped write behind the meal detail's `Add n to <list>` (P3-43, §5.3):
 * the selected stable `ing_` ids to one named destination, as one request that is accepted
 * or refused whole. A refusal (the meal's rows changed under the selection, 409) is the
 * `Reopen` toast; any other failure offers `Retry` with the same variables.
 *
 * The hook, not the section, owns the mutation (`coding-standards.md` §8.2): the component
 * renders the picker and hands the selection here.
 */
export interface AddIngredientsInput {
  listId: string;
  ingredientIds: readonly string[];
}

export function useAddIngredients(
  activityId: string,
  options: { onSettledSelection: () => void },
) {
  const queryClient = useQueryClient();
  const { onSettledSelection } = options;

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
    onSuccess: async () => {
      onSettledSelection();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: activityKey(activityId) }),
        queryClient.invalidateQueries({ queryKey: LISTS_KEY }),
      ]);
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
                void queryClient.invalidateQueries({ queryKey: activityKey(activityId) });
              },
            }
          : { label: 'Retry', onPress: () => add.mutate(variables) },
      });
    },
  });

  return add;
}
