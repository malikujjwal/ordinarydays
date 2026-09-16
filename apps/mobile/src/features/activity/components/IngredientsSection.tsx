import type { MealIngredient } from '@od/shared/types';
import { useState } from 'react';
import { IngredientPicker } from '@/components/IngredientPicker';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { useAddIngredients } from '@/features/activity/hooks/useAddIngredients';
import { useDestination } from '@/hooks/useDestination';

/**
 * The INGREDIENTS section on a Meal (P3-43, `plans-and-lists.md` §7.3): rows with
 * selection checkboxes that start unchecked, the destination resolved through the
 * `groceries` slot and always shown, and the one named action `Add n to <list>` that calls
 * P3-17's activity-scoped route with the selected stable `ing_` ids. Rows already added
 * read `Added` and cannot be added twice from this meal.
 *
 * A refused write — the meal's rows changed under the selection — is the whole action
 * refused, never a partial add (§5.3): the toast's `Reopen` refetches the meal.
 *
 * 2026-09-10 (founder): the count sits beside the label (`4`, `1 of 4 on a list`), a
 * trailing `Edit` opens the meal sheet where the rows themselves are edited, and the add
 * action appears at the section's foot only once a row is selected.
 */
export interface IngredientsSectionProps {
  activityId: string;
  ingredients: readonly MealIngredient[];
  /** This operation's one-off destination from the picker; the route keeps it. */
  destinationOverride: string | undefined;
  onChangeDestination: () => void;
  /** Opens the meal sheet to rename, add or remove rows. Absent while pending. */
  onEdit?: () => void;
}

export function IngredientsSection({
  activityId,
  ingredients,
  destinationOverride,
  onChangeDestination,
  onEdit,
}: IngredientsSectionProps) {
  const destination = useDestination('groceries', destinationOverride);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const add = useAddIngredients(activityId, {
    onSettledSelection: () => setSelected(new Set()),
  });

  const addedCount = ingredients.filter((row) => row.addedToListId !== undefined).length;

  return (
    <SectionFrame
      label="Ingredients"
      meta={
        addedCount === 0
          ? String(ingredients.length)
          : `${addedCount} of ${ingredients.length} on a list`
      }
      ruled
      {...(onEdit === undefined
        ? {}
        : {
            trailing: 'Edit',
            trailingAccessibilityLabel: 'Edit ingredients',
            onTrailingPress: onEdit,
            trailingTestID: 'ingredients-edit',
          })}
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
        onChangeDestination={onChangeDestination}
        onAdd={(ingredientIds) => {
          const listId = destination.list?.listId;
          if (listId === undefined) return;
          add.mutate({ listId, ingredientIds });
        }}
        busy={add.isPending}
        layout="footer"
      />
    </SectionFrame>
  );
}
