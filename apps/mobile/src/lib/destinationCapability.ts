import { canReceiveIngredients } from '@od/shared/lists';
import type { DefaultSlot, List } from '@od/shared/types';

type CapableRow = Pick<List, 'itemStateMode' | 'capabilities'>;

export type DestinationCapability = (list: CapableRow) => boolean;

/**
 * A list's ingredient capability, preferring the field the API already derived
 * (`services/api/src/handlers/toList.ts`) over recomputing it. Every `List` a destination flow
 * sees carries the field by the time it reaches here — the API response sets it, and so does
 * every local construction (`pendingList.ts`, the native list projection) — but a fixture or a
 * row built before that plumbing existed may still lack it, so the one shared rule
 * (`canReceiveIngredients`) is the fallback, never a second implementation.
 */
function hasIngredientCapability(list: CapableRow): boolean {
  return list.capabilities?.ingredients ?? canReceiveIngredients(list);
}

/**
 * Capability required by the write routed through a default slot.
 *
 * Slots choose a default; they do not enable list features. Meal ingredients therefore use
 * the same shared predicate as the API guard, while Watch and Meals accept ordinary rows and
 * have no additional capability requirement.
 */
export function capabilityFor(slot: DefaultSlot): DestinationCapability | undefined {
  return slot === 'groceries' ? hasIngredientCapability : undefined;
}

/** Applies an operation's capability boundary before a destination is offered or chosen. */
export function destinationCapableLists(
  slot: DefaultSlot,
  lists: readonly List[],
): readonly List[] {
  const capability = capabilityFor(slot);
  return lists.filter(
    (list) => !list.archived && (capability === undefined || capability(list)),
  );
}
