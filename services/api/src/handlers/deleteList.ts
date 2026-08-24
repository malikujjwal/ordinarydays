import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { removeList } from '../services/listService.js';

/**
 * `DELETE /v1/lists/:id` (`api-contract.md` §2.7).
 *
 * Owner only. A member gets `403` — they can see the list and are being told they may not
 * delete it — and anyone else gets `404`, which is also what a list that does not exist
 * returns, so a guessed id confirms nothing.
 *
 * `200` with the envelope rather than `204`, per §1's rule; `data` names the id that is
 * gone. **Safe to retry**: the cascade is resumable, and once the pointer is down a second
 * call answers `404`. There is no `If-Match` — a delete is not an edit racing another edit.
 */
export const DELETE_LIST_PATH = '/:id';

export async function deleteListHandler(
  c: Context<AppEnv, typeof DELETE_LIST_PATH>,
): Promise<Response> {
  const listId = await removeList(
    requireUserId(c),
    c.req.param('id'),
    new Date().toISOString(),
  );

  return c.json({
    data: { listId },
    meta: { requestId: c.get('requestId') },
  });
}
