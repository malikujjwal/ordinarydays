import { ApiError, addIngredientsToList } from '@od/shared/client';
import type { MealIngredient } from '@od/shared/types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useState } from 'react';
import { IngredientPicker } from '@/components/IngredientPicker';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { useDestination } from '@/hooks/useDestination';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { INGREDIENTS_CHANGED } from '@/lib/destinationCopy';
import { activityKey, LISTS_KEY } from '@/lib/queryKeys';
import { useToast } from '@/stores/toast';

/**
 * The INGREDIENTS section on a Meal (P3-43, `plans-and-lists.md` §7.3): rows with
 * selection checkboxes that start unchecked, the destination resolved through the
 * `groceries` slot and always shown, and the one named action `Add n to <list>` that calls
 * P3-17's activity-scoped route with the selected stable `ing_` ids. Rows already added
 * read `Added` and cannot be added twice from this meal.
 *
 * A refused write — the meal's rows changed under the selection — is the whole action
 * refused, never a partial add (§5.3): the toast's `Reopen` refetches the meal.
 */
export interface IngredientsSectionProps {
  activityId: string;
  ingredients: readonly MealIngredient[];
  /** This operation's one-off destination from the picker; the route keeps it. */
  destinationOverride: string | undefined;
  onChangeDestination: () => void;
}

export function IngredientsSection({
  activityId,
  ingredients,
  destinationOverride,
  onChangeDestination,
}: IngredientsSectionProps) {
  const queryClient = useQueryClient();
  const destination = useDestination('groceries', destinationOverride);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const add = useMutation({
    mutationFn: (input: { listId: string; ingredientIds: readonly string[] }) =>
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
      setSelected(new Set());
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: activityKey(activityId) }),
        queryClient.invalidateQueries({ queryKey: LISTS_KEY }),
      ]);
    },
    onError: (error: unknown) => {
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
                setSelected(new Set());
                void queryClient.invalidateQueries({ queryKey: activityKey(activityId) });
              },
            }
          : { label: 'Retry', onPress: () => add.mutate(add.variables as never) },
      });
    },
  });

  const addedCount = ingredients.filter((row) => row.addedToListId !== undefined).length;

  return (
    <SectionFrame
      label="Ingredients"
      trailing={
        addedCount === 0
          ? String(ingredients.length)
          : `${addedCount} of ${ingredients.length} added`
      }
      testID="section-ingredients"
    >
      <IngredientPicker
        rows={ingredients}
        selected={selected}
        onToggle={(ingredientId, on) =>
          setSelected((current) => {
            const next = new Set(current);
            if (on) next.add(ingredientId);
            else next.delete(ingredientId);
            return next;
          })
        }
        destinationTitle={destination.list?.title}
        destinationState={destination.resolution?.kind}
        onChangeDestination={onChangeDestination}
        onAdd={(ingredientIds) => {
          const listId = destination.list?.listId;
          if (listId === undefined) return;
          add.mutate({ listId, ingredientIds });
        }}
        busy={add.isPending}
      />
    </SectionFrame>
  );
}
