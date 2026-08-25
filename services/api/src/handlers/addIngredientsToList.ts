import type { AddIngredientsToListInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { addIngredientsToList } from '../services/ingredientsToListService.js';
import { idempotentJson } from './idempotentResponse.js';
import { toListItem } from './toList.js';

/**
 * `POST /v1/activities/:id/ingredients/add-to-list` (`api-contract.md` §2.7, §P3-17).
 *
 * `201`, because the ordinary case creates rows. It stays `201` when every ingredient
 * deduplicated onto existing unchecked rows and nothing new was written: the status describes
 * the operation, not the row count, and a client would have to inspect `outcome` per
 * ingredient to know the difference anyway — which is exactly what that field is for.
 *
 * The receipt is built from the committed result, not before it, so a replay returns the
 * item ids that were actually written (`listRepository.ts`, and the defect P3-08 learned it
 * from).
 *
 * `toListItem` drops `itemRevision`, the storage-only mutation fence, from every row. The
 * items go out through the same projection every other list response uses, so a field this
 * endpoint alone leaked would be a field one call site forgot — the reason the trim lives in
 * the projection rather than at each handler.
 */
export const ADD_INGREDIENTS_TO_LIST_PATH = '/:id/ingredients/add-to-list';

export async function addIngredientsToListHandler(
  c: Context<AppEnv, typeof ADD_INGREDIENTS_TO_LIST_PATH>,
  input: AddIngredientsToListInput,
  now: string,
): Promise<Response> {
  const userId = requireUserId(c);

  return idempotentJson(c, 201, (receiptFor) =>
    addIngredientsToList(userId, c.req.param('id'), input, now, (result) =>
      receiptFor({
        listId: result.listId,
        sourceLabel: result.sourceLabel,
        ingredients: result.ingredients.map((row) => ({
          ingredientId: row.ingredientId,
          outcome: row.outcome,
          item: toListItem(row.item),
        })),
      }),
    ),
  );
}
