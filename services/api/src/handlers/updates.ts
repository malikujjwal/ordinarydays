import type { PostActivityUpdateInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { deleteUpdate, listUpdates, postUpdate } from '../services/updatesService.js';
import { idempotentJson } from './idempotentResponse.js';

/** `api-contract.md` §2.5. Mounted under `/v1/activities` by `routes/updates.ts`. */
export const UPDATES_PATH = '/:id/updates';
export const UPDATE_PATH = '/:id/updates/:updateId';

export async function listUpdatesHandler(
  c: Context<AppEnv, typeof UPDATES_PATH>,
): Promise<Response> {
  const page = await listUpdates(
    requireUserId(c),
    c.req.param('id'),
    c.req.query('cursor'),
  );
  return c.json({ data: page, meta: { requestId: c.get('requestId') } });
}

export async function postUpdateHandler(
  c: Context<AppEnv, typeof UPDATES_PATH>,
  input: PostActivityUpdateInput,
  now: string,
): Promise<Response> {
  return idempotentJson(c, 201, async (receiptFor) =>
    postUpdate(requireUserId(c), c.req.param('id'), input.body, now, (result) =>
      receiptFor(result),
    ),
  );
}

/** `DELETE` keeps the universal `{ data, meta }` response envelope. */
export async function deleteUpdateHandler(
  c: Context<AppEnv, typeof UPDATE_PATH>,
): Promise<Response> {
  const updateId = c.req.param('updateId');
  await deleteUpdate(requireUserId(c), c.req.param('id'), updateId);
  return c.json({ data: { updateId }, meta: { requestId: c.get('requestId') } });
}
