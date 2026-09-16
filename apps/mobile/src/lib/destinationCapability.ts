import { canReceiveIngredients } from '@od/shared/lists';
import type { DefaultSlot, List } from '@od/shared/types';

export type DestinationCapability = (list: Pick<List, 'itemStateMode'>) => boolean;

/**
 * Capability required by the write routed through a default slot.
 *
 * Slots choose a default; they do not enable list features. Meal ingredients therefore use
 * the same shared predicate as the API guard, while Watch and Meals accept ordinary rows and
 * have no additional capability requirement.
 */
export function capabilityFor(slot: DefaultSlot): DestinationCapability | undefined {
  return slot === 'groceries' ? canReceiveIngredients : undefined;
}

/** Applies an operation's capability boundary before slot routing or one-off selection. */
export function destinationCapableLists(
  slot: DefaultSlot,
  lists: readonly List[],
): readonly List[] {
  const capability = capabilityFor(slot);
  return lists.filter(
    (list) => !list.archived && (capability === undefined || capability(list)),
  );
}
