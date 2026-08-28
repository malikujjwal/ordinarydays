import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { getListDetail } from '../services/listService.js';
import { toList, toListItem, toListItemLink } from './toList.js';

/**
 * `GET /v1/lists/:id?includeItems=true` (`api-contract.md` §2.7, access pattern 8b).
 *
 * META alone without the flag; with it, the repository's fenced first item page plus the
 * caller-only link join, each surviving link already authorised as a readable Activity. A
 * repair or migration fence failure surfaces as the retryable `503` via `errorHandler`.
 *
 * The path parameter is not validated against the `lst_` ULID shape, for `deleteDevice`'s
 * reason: a malformed id addresses no pointer and already answers `404`.
 */
export const GET_LIST_PATH = '/:id';

export async function getListHandler(
  c: Context<AppEnv, typeof GET_LIST_PATH>,
  query: { includeItems?: 'true' | 'false' | undefined },
  now: string,
): Promise<Response> {
  const detail = await getListDetail(
    requireUserId(c),
    c.req.param('id'),
    query.includeItems === 'true',
    now,
  );

  return c.json({
    data: {
      list: toList(detail.list),
      ...(detail.items === undefined
        ? {}
        : {
            items: detail.items.map((row) => ({
              item: toListItem(row.item),
              /**
               * Narrowed rather than destructured: the row is a union of linked and unlinked
               * shapes, so a half-pair cannot be written here even by mistake.
               */
              ...('viewerLink' in row
                ? {
                    viewerLink: toListItemLink(row.viewerLink),
                    viewerPlan: row.viewerPlan,
                  }
                : {}),
            })),
          }),
      ...(detail.nextCursor === undefined ? {} : { nextCursor: detail.nextCursor }),
    },
    meta: { requestId: c.get('requestId') },
  });
}
