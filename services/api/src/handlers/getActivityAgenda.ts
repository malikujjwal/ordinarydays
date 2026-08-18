import type { AgendaQuery } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getActivityAgenda } from '../services/agendaQueryService.js';

export const GET_ACTIVITY_AGENDA_PATH = '/activities/:id';

/** Serves one canonical projection without cache validators or GSI discovery. */
export async function getActivityAgendaHandler(
  c: Context<AppEnv, typeof GET_ACTIVITY_AGENDA_PATH>,
  query: AgendaQuery,
  now: string,
): Promise<Response> {
  const data = await getActivityAgenda(requireUserId(c), c.req.param('id'), query, now);
  c.header('Cache-Control', 'private, no-store');
  return c.json({ data, meta: { requestId: c.get('requestId') } });
}
