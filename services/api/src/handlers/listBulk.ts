import type { UndoListOperationInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { clearCheckedItems, uncheckAllItems } from '../services/listItemService.js';
import { undoListOperation } from '../services/listUndoService.js';
import { idempotentJson } from './idempotentResponse.js';

/**
 * The three bulk list actions (`api-contract.md` §2.7, §P3-10).
 *
 * Grouped for `listItems.ts`'s reason: they are one resource, they share one response shape,
 * and they share the rule that makes them a group at all — each is a **reversible bulk
 * action**, so each answers with a token and a 10-second window rather than with a dialog.
 *
 * All three are registered `mutates: true`. `clear-checked` and `uncheck-all` because they
 * are creates in reverse and a retried request must not run twice; `undo` because a
 * compensation is exactly the kind of write an offline coordinator replays, and its receipt is
 * what makes that replay return the first answer instead of consuming a second operation.
 */

export const CLEAR_CHECKED_PATH = '/:id/clear-checked';
export const UNCHECK_ALL_PATH = '/:id/uncheck-all';
export const UNDO_PATH = '/:id/undo';

/**
 * `POST /v1/lists/:id/clear-checked` — the end of a shopping trip.
 *
 * **No confirmation dialog** (§P3-10's decision, `00-open-decisions.md` item 33): the count is
 * in the button the user tapped, and the 10-second undo window is the safety net. The
 * response carries the token that window offers.
 */
export async function clearCheckedHandler(
  c: Context<AppEnv, typeof CLEAR_CHECKED_PATH>,
  now: string,
): Promise<Response> {
  const listId = c.req.param('id');
  return idempotentJson(c, 200, async (receiptFor) =>
    clearCheckedItems(requireUserId(c), listId, now, (result) => receiptFor(result)),
  );
}

/** `POST /v1/lists/:id/uncheck-all` — the same window, on a change that loses nothing. */
export async function uncheckAllHandler(
  c: Context<AppEnv, typeof UNCHECK_ALL_PATH>,
  now: string,
): Promise<Response> {
  const listId = c.req.param('id');
  return idempotentJson(c, 200, async (receiptFor) =>
    uncheckAllItems(requireUserId(c), listId, now, (result) => receiptFor(result)),
  );
}

/**
 * `POST /v1/lists/:id/undo` — the one compensation endpoint.
 *
 * Answers `200` with a discriminated outcome rather than an error for a token that no longer
 * applies: the server was asked what happened to a compensation, and "it was already used" is
 * an answer to that question, not a failed request. The union is defined once in
 * `packages/shared/src/schemas/list.ts` so P3-24 maps one shape (`api-contract.md` §2.7,
 * amended in this task's pull request).
 */
export async function undoListOperationHandler(
  c: Context<AppEnv, typeof UNDO_PATH>,
  input: UndoListOperationInput,
  now: string,
): Promise<Response> {
  const listId = c.req.param('id');
  return idempotentJson(c, 200, async (receiptFor) => {
    const result = await undoListOperation(
      requireUserId(c),
      listId,
      input.undoToken,
      now,
      (affectedCount) => receiptFor({ outcome: 'applied', affectedCount }),
    );
    /**
     * Sets the response body for the two outcomes that **write nothing** — and therefore
     * store no receipt, so a replay of the same key re-answers rather than replaying. Both
     * are idempotent by construction: a token that named nothing still names nothing, and one
     * whose preconditions moved has not moved back. On the applied path the compensation's
     * own transaction already stored this body; building it again is the same JSON.
     */
    receiptFor(result);
    return result;
  });
}
