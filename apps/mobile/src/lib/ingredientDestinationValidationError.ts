/**
 * The selected list changed after it was shown as an ingredient destination.
 *
 * The message tells the user how to recover without exposing SQLite or sync details.
 */
export const INGREDIENT_DESTINATION_UNAVAILABLE =
  'That list can no longer receive ingredients. Choose another list and try again.';

export class IngredientDestinationUnavailableError extends Error {
  constructor() {
    super(INGREDIENT_DESTINATION_UNAVAILABLE);
    this.name = 'IngredientDestinationUnavailableError';
  }
}

export function isIngredientDestinationUnavailable(
  error: unknown,
): error is IngredientDestinationUnavailableError {
  return error instanceof IngredientDestinationUnavailableError;
}
