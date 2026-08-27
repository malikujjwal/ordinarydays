import type { ChangeListBehaviourInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { AppError } from '../lib/errors.js';
import { entityTag } from '../lib/etag.js';
import { requireUserId } from '../middleware/identity.js';
import { changeListBehaviour } from '../services/listMutationService.js';
import { idempotentJson, undoAwareReceiptTtlSeconds } from './idempotentResponse.js';
import { toListSettings } from './toList.js';

/**
 * `POST /v1/lists/:id/behaviour` (`api-contract.md` §2.7, §P3-09).
 *
 * A behaviour change is an **operation**, not a field edit, and the route says so: it needs
 * `If-Match` because it replaces a version, and `Idempotency-Key` because it starts a
 * resumable migration a retried request must join rather than duplicate. The registry entry
 * carries `mutates: true`, so the existing middleware owns receipt lookup, response replay
 * and races — there is no second, `PATCH`-shaped receipt path.
 *
 * A destructive retry echoes the typed `confirmation` object returned by the refused call.
 * Its `itemVersion`, count and field list bind the write to exactly what the user saw.
 */
export const LIST_BEHAVIOUR_PATH = '/:id/behaviour';

const MISSING = 'This change needs an If-Match header carrying the version you loaded.';

export async function changeListBehaviourHandler(
  c: Context<AppEnv, typeof LIST_BEHAVIOUR_PATH>,
  input: ChangeListBehaviourInput,
  now: string,
): Promise<Response> {
  const header = c.req.header('If-Match');
  if (header === undefined || header.trim() === '') {
    throw new AppError('validation_failed', MISSING, [
      { path: 'If-Match', message: MISSING },
    ]);
  }

  const listId = c.req.param('id');
  return idempotentJson(
    c,
    200,
    async (receiptFor, key) =>
      changeListBehaviour(
        requireUserId(c),
        listId,
        input,
        entityTag(header.trim()),
        key,
        now,
        (result) => receiptFor(toListSettings(result)),
      ),
    { receiptTtlSeconds: undoAwareReceiptTtlSeconds },
  );
}
