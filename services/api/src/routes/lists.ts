import { zValidator } from '@hono/zod-validator';
import {
  bulkCreateListItemsInput,
  createListInput,
  createListItemInput,
  listDetailQuery,
  listItemPageQuery,
  listListQuery,
  patchListItemInput,
} from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { createListHandler } from '../handlers/createList.js';
import { DELETE_LIST_PATH, deleteListHandler } from '../handlers/deleteList.js';
import { GET_LIST_PATH, getListHandler } from '../handlers/getList.js';
import {
  BULK_LIST_ITEMS_PATH,
  bulkCreateListItemsHandler,
  createListItemHandler,
  deleteListItemHandler,
  getListItemHandler,
  LIST_ITEM_PATH,
  LIST_ITEMS_PATH,
  listListItemsHandler,
  patchListItemHandler,
} from '../handlers/listItems.js';
import { LIST_LISTS_PATH, listListsHandler } from '../handlers/listLists.js';

/**
 * `/v1/lists` (`api-contract.md` §2.7).
 *
 * Four routes in this task: create with template resolution, the Lists-tab page, list
 * detail with its optional fenced item page, and the owner-only delete (P3-05). Items,
 * bulk, settings, behaviour, undo and the schedule bridge are later tasks and are absent
 * rather than stubbed, so `routeSplit`'s `not_implemented` answers for them.
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise. Only
 * the `POST` creates, so only it takes an `Idempotency-Key`.
 */

/**
 * `zValidator` with an explicit failure hook that **throws**, for the reason `me.ts`
 * records: its default answers with its own body, which is not the contract envelope and
 * never reaches `errorHandler`, so a client would get a `400` with no `error.code` and no
 * `requestId`.
 *
 * The create schema is **strict**, and that is the template boundary on the wire: a body
 * carrying `behaviour`, `capabilities`, `slot`, `icon` or `emptyStateCopy` is a `400`
 * naming the field, never a save that quietly ignores a seed the catalogue owns.
 */
const validateCreate = zValidator('json', createListInput, (result) => {
  if (!result.success) throw result.error;
});

/** Same hook, on the query string. Strict, so a misspelled parameter is a named `400`. */
const validateListQuery = zValidator('query', listListQuery, (result) => {
  if (!result.success) throw result.error;
});

const validateDetailQuery = zValidator('query', listDetailQuery, (result) => {
  if (!result.success) throw result.error;
});

/**
 * The item bodies, validated against the **behaviour-free** shape here and against the
 * loaded list's behaviour in the service.
 *
 * The split is not a choice: an item body does not carry its list's behaviour, and a
 * validator has no database. So the strict shape — unknown keys, types, bounds, and the
 * server-owned fields `checked`, `rank`, `itemRevision` and the provenance pair — is settled
 * at the edge, and `details.behaviour` matching plus the two-part capability gates are
 * applied once the row is loaded (`schemas/list.ts`, P3-01).
 */
const validateCreateItem = zValidator('json', createListItemInput, (result) => {
  if (!result.success) throw result.error;
});

const validateBulkCreateItems = zValidator('json', bulkCreateListItemsInput, (result) => {
  if (!result.success) throw result.error;
});

const validatePatchItem = zValidator('json', patchListItemInput, (result) => {
  if (!result.success) throw result.error;
});

const validateItemPageQuery = zValidator('query', listItemPageQuery, (result) => {
  if (!result.success) throw result.error;
});

export const lists = new Hono<AppEnv>()
  .get(LIST_LISTS_PATH, validateListQuery, (c) =>
    listListsHandler(c, c.req.valid('query')),
  )
  .post('/', validateCreate, (c) =>
    /**
     * `new Date()` at the edge, as everywhere: the route is the boundary where the real
     * clock is read and handed down as a value (`coding-standards.md` §4.3).
     */
    createListHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  .get(GET_LIST_PATH, validateDetailQuery, (c) => getListHandler(c, c.req.valid('query')))
  .delete(DELETE_LIST_PATH, deleteListHandler)
  /**
   * `bulk` is mounted **before** `/:itemId` so the literal segment cannot be swallowed as an
   * item id. Hono's router prefers a static segment over a parameter, so this is belt and
   * braces rather than load-bearing — but the belt costs one line and the failure it guards
   * against is a `bulk` insert silently becoming a `404` for the item named "bulk".
   */
  .post(BULK_LIST_ITEMS_PATH, validateBulkCreateItems, (c) =>
    bulkCreateListItemsHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  .get(LIST_ITEMS_PATH, validateItemPageQuery, (c) =>
    listListItemsHandler(c, c.req.valid('query')),
  )
  .post(LIST_ITEMS_PATH, validateCreateItem, (c) =>
    createListItemHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  .get(LIST_ITEM_PATH, getListItemHandler)
  .patch(LIST_ITEM_PATH, validatePatchItem, (c) =>
    patchListItemHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  /**
   * No `If-Match`. A delete is not an edit racing another edit: the item either exists and
   * goes, or it does not and the answer is `404` — the same reasoning the Activity delete
   * records.
   */
  .delete(LIST_ITEM_PATH, deleteListItemHandler);
