import type { AgendaQuery } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { matchesIfNoneMatch, weakEntityTag } from '../lib/etag.js';
import { requireUserId } from '../middleware/identity.js';
import { getAgenda } from '../services/agendaQueryService.js';

export const GET_AGENDA_PATH = '/';
export const AGENDA_CACHE_CONTROL = 'private, max-age=60';

/**
 * Serves the complete window and hashes only its stable `data` payload.
 *
 * The validator is **weak**, because `meta.requestId` differs on every response and a strong
 * tag would claim a byte-identity the envelope makes impossible — see `lib/etag.ts`.
 */
export async function getAgendaHandler(
  c: Context<AppEnv>,
  query: AgendaQuery,
  now: string,
): Promise<Response> {
  const data = await getAgenda(requireUserId(c), query, now);
  const etag = weakEntityTag(data);

  c.header('ETag', etag);
  c.header('Cache-Control', AGENDA_CACHE_CONTROL);

  if (matchesIfNoneMatch(c.req.header('If-None-Match'), etag)) {
    return c.body(null, 304);
  }

  return c.json({ data, meta: { requestId: c.get('requestId') } });
}
