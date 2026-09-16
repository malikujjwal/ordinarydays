import { canReceiveIngredients } from '@od/shared/lists';
import { requireActiveNativeState } from '@/lib/sqlite/nativeState';
import { IngredientDestinationUnavailableError } from './ingredientDestinationValidationError';

/**
 * Fails closed unless the selected destination is capable in the current committed SQLite
 * projection. This read happens at the send seam, after any local list-settings transaction,
 * so queued sync cannot let the server's older list mode authorize a stale native choice.
 */
export async function validateIngredientDestination(listId: string): Promise<void> {
  try {
    const listsRepository = requireActiveNativeState().lists;
    if (listsRepository === undefined) throw new IngredientDestinationUnavailableError();
    const snapshot = await listsRepository.readSnapshot();
    const destination = snapshot.lists.find((list) => list.listId === listId);
    if (destination === undefined || !canReceiveIngredients(destination)) {
      throw new IngredientDestinationUnavailableError();
    }
  } catch (error) {
    if (error instanceof IngredientDestinationUnavailableError) throw error;
    throw new IngredientDestinationUnavailableError();
  }
}
