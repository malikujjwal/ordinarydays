import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { listLists } from '../services/listService.js';
import { toList } from './toList.js';

/**
 * `GET /v1/lists?cursor=` (`api-contract.md` §2.7, access pattern 7).
 *
 * One pointer `Query` and one `BatchGetItem` per page, 50 pointers at a time. The cursor is
 * not optional as a concept: the 100 cap applies to Lists the caller **owns**, and incoming
 * memberships can exceed any fixed page.
 */
export const LIST_LISTS_PATH = '/';

export async function listListsHandler(
  c: Context<AppEnv>,
  query: { cursor?: string | undefined },
): Promise<Response> {
  const page = await listLists(requireUserId(c), query.cursor);

  return c.json({
    data: page.items.map(toList),
    meta: {
      requestId: c.get('requestId'),
      // Present only when there is more — the client branches on presence, not emptiness.
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
  });
}
