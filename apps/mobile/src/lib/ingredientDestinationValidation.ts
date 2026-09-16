/**
 * Web sends against the TanStack list snapshot that produced the current destination.
 * The API remains its authority, so no additional client read is required here.
 */
export function validateIngredientDestination(_listId: string): Promise<void> {
  return Promise.resolve();
}
