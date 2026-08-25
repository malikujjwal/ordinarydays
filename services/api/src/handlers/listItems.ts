import type {
  BulkCreateListItemsInput,
  CreateListItemInput,
  PatchListItemInput,
} from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import {
  createItem,
  createItemsBulk,
  getItemById,
  listItemsFor,
  patchItem,
  removeItem,
} from '../services/listItemService.js';
import { idempotentJson } from './idempotentResponse.js';
import { toListItem, toListItemLink } from './toList.js';

/**
 * The six ListItem routes under `/v1/lists/:id` (`api-contract.md` §2.7, P3-08).
 *
 * Grouped in one file the way `activityReminders.ts` groups its three: they are one
 * resource, they share a projection, and six files of eight lines each would hide that.
 *
 * Every rule — the item cap, the two-part capability gates, rank allocation, the repair
 * retry, the Undo record — lives in `listItemService`. These read validated input, call one
 * service function, and put the result in the envelope.
 *
 * The path parameters are not validated against their ULID schemas, for the reason
 * `deleteDevice` records: a malformed id resolves to nothing and already answers `404`, and
 * checking it first would turn one user-visible fact into two statuses.
 */

export const LIST_ITEMS_PATH = '/:id/items';
export const BULK_LIST_ITEMS_PATH = '/:id/items/bulk';
export const LIST_ITEM_PATH = '/:id/items/:itemId';

/**
 * `POST /v1/lists/:id/items` — `201`, and the receipt joins the create transaction.
 *
 * The registry entry carries `mutates: true`, so a retried request replays the stored
 * response rather than adding a second copy of an item the user typed once.
 */
export async function createListItemHandler(
  c: Context<AppEnv, typeof LIST_ITEMS_PATH>,
  input: CreateListItemInput,
  now: string,
): Promise<Response> {
  const listId = c.req.param('id');
  return idempotentJson(c, 201, async (receiptFor) =>
    createItem(requireUserId(c), listId, input, now, (item) =>
      receiptFor(toListItem(item)),
    ),
  );
}

/** `POST /v1/lists/:id/items/bulk` — one ordered sequence, chunked when it does not fit. */
export async function bulkCreateListItemsHandler(
  c: Context<AppEnv, typeof BULK_LIST_ITEMS_PATH>,
  input: BulkCreateListItemsInput,
  now: string,
): Promise<Response> {
  const listId = c.req.param('id');
  return idempotentJson(c, 201, async (receiptFor) =>
    createItemsBulk(requireUserId(c), listId, input, now, (items) =>
      receiptFor(items.map(toListItem)),
    ),
  );
}

/**
 * `PATCH /v1/lists/:id/items/:itemId`.
 *
 * **No `If-Match`**, unlike the Activity patch: item writes are per-field last-write-wins,
 * and optimistic concurrency on every checkbox in a grocery list would produce constant
 * spurious `409`s for no benefit (`data-model.md` §4.6). The internal `itemRevision` is a
 * retry fence, not a client-visible conflict.
 */
export async function patchListItemHandler(
  c: Context<AppEnv, typeof LIST_ITEM_PATH>,
  input: PatchListItemInput,
  now: string,
): Promise<Response> {
  const item = await patchItem(
    requireUserId(c),
    c.req.param('id'),
    c.req.param('itemId'),
    input,
    now,
  );

  return c.json({
    data: toListItem(item),
    meta: { requestId: c.get('requestId') },
  });
}

/**
 * `DELETE /v1/lists/:id/items/:itemId` — `200` with the Undo offer.
 *
 * Answers `{ affectedCount, undoToken, undoExpiresAt }` rather than the deleted item: the
 * client must not send row contents back as authority, so the server keeps the snapshot and
 * hands out an opaque token (`api-contract.md` §2.7). Restoring it is P3-10's endpoint.
 */
export async function deleteListItemHandler(
  c: Context<AppEnv, typeof LIST_ITEM_PATH>,
): Promise<Response> {
  const result = await removeItem(
    requireUserId(c),
    c.req.param('id'),
    c.req.param('itemId'),
    new Date().toISOString(),
  );

  return c.json({
    data: result,
    meta: { requestId: c.get('requestId') },
  });
}

/** `GET /v1/lists/:id/items?cursor=` — pattern 8's fenced page with the caller's links. */
export async function listListItemsHandler(
  c: Context<AppEnv, typeof LIST_ITEMS_PATH>,
  query: { cursor?: string | undefined },
): Promise<Response> {
  const page = await listItemsFor(requireUserId(c), c.req.param('id'), query.cursor);

  return c.json({
    data: page.items.map(({ item, viewerLink, viewerPlan }) => ({
      item: toListItem(item),
      ...(viewerLink === undefined ? {} : { viewerLink: toListItemLink(viewerLink) }),
      /**
       * Passed through rather than re-projected: `toPlanState` in the service already trimmed
       * it to the four fields a row may reveal, and a second trim here would be a second
       * place to get that contract wrong.
       */
      ...(viewerPlan === undefined ? {} : { viewerPlan }),
    })),
    meta: {
      requestId: c.get('requestId'),
      // Present only when there is more, and bound to the rank generation that issued it.
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    },
  });
}

/**
 * `GET /v1/lists/:id/items/:itemId` — the authoritative exact read.
 *
 * What durable creation reconciles a lost response against: `200` adopts the server row,
 * `404` parks the intent for explicit Retry or Discard (ADR-055). A tombstoned id answers
 * `404` exactly as a missing one does.
 */
export async function getListItemHandler(
  c: Context<AppEnv, typeof LIST_ITEM_PATH>,
): Promise<Response> {
  const item = await getItemById(
    requireUserId(c),
    c.req.param('id'),
    c.req.param('itemId'),
  );

  return c.json({
    data: toListItem(item),
    meta: { requestId: c.get('requestId') },
  });
}
