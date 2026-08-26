import { zValidator } from '@hono/zod-validator';
import {
  bulkCreateListItemsInput,
  changeListBehaviourInput,
  changeListBehaviourQuery,
  createListInput,
  createListItemInput,
  listDetailQuery,
  listItemPageQuery,
  listListQuery,
  patchListInput,
  patchListItemInput,
  scheduleListItemInput,
  undoListOperationInput,
} from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import {
  changeListBehaviourHandler,
  LIST_BEHAVIOUR_PATH,
} from '../handlers/changeListBehaviour.js';
import { createListHandler } from '../handlers/createList.js';
import { DELETE_LIST_PATH, deleteListHandler } from '../handlers/deleteList.js';
import { GET_LIST_PATH, getListHandler } from '../handlers/getList.js';
import {
  CLEAR_CHECKED_PATH,
  clearCheckedHandler,
  UNCHECK_ALL_PATH,
  UNDO_PATH,
  uncheckAllHandler,
  undoListOperationHandler,
} from '../handlers/listBulk.js';
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
import { PATCH_LIST_PATH, patchListHandler } from '../handlers/patchList.js';
import {
  SCHEDULE_LIST_ITEM_PATH,
  scheduleListItemHandler,
} from '../handlers/scheduleListItem.js';

/**
 * `/v1/lists` (`api-contract.md` §2.7).
 *
 * Create with template resolution, the Lists-tab page, list detail with its optional fenced
 * item page and the owner-only delete (P3-05); the six item routes (P3-08); and the two
 * settings routes (P3-09); and the two bulk actions with their compensation endpoint
 * (P3-10); and the optional bridge to Activities (P3-13).
 *
 * Every entry is registered in `ROUTE_REGISTRY`; app construction throws otherwise. Only the
 * mutating `POST`s take an `Idempotency-Key`, and only the two conditional routes — the
 * settings `PATCH` and the behaviour `POST` — take an `If-Match`.
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

/**
 * The bridge body. **Strict all the way down**, which is what makes the endpoint's promise
 * keepable: both explicit choices are required, so a request that skipped the Plan-kind or
 * audience step never reaches the handler, and no nested unknown field is quietly stripped
 * from a Plan the user thought they were confirming (`CLAUDE.md` rule 2, P3-13).
 */
const validateSchedule = zValidator('json', scheduleListItemInput, (result) => {
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

/**
 * The settings body, strict — which is where the change-rules table is enforced on the wire.
 * A `PATCH` carrying `templateKey` is immutable provenance and a `PATCH` carrying
 * `behaviour` belongs on the replay-protected action below; both are a `400` naming the
 * field rather than a save that quietly drops half of what was sent.
 */
const validatePatchList = zValidator('json', patchListInput, (result) => {
  if (!result.success) throw result.error;
});

const validateBehaviour = zValidator('json', changeListBehaviourInput, (result) => {
  if (!result.success) throw result.error;
});

const validateBehaviourQuery = zValidator('query', changeListBehaviourQuery, (result) => {
  if (!result.success) throw result.error;
});

/**
 * The compensation body: the opaque token and nothing else, strictly.
 *
 * A client must never send the deleted rows back as authority (`api-contract.md` §2.7) — the
 * server holds the snapshot — so a body that tried to is a `400` naming the field rather than
 * a restore from data the request supplied.
 */
const validateUndo = zValidator('json', undoListOperationInput, (result) => {
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
  .patch(PATCH_LIST_PATH, validatePatchList, (c) =>
    patchListHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  /**
   * Mounted before the item routes for the same belt-and-braces reason `bulk` is: a literal
   * segment that a parameter could swallow is worth stating first, even where Hono's router
   * already prefers the static one.
   */
  .post(LIST_BEHAVIOUR_PATH, validateBehaviour, validateBehaviourQuery, (c) =>
    changeListBehaviourHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
  .post(CLEAR_CHECKED_PATH, (c) => clearCheckedHandler(c, new Date().toISOString()))
  .post(UNCHECK_ALL_PATH, (c) => uncheckAllHandler(c, new Date().toISOString()))
  .post(UNDO_PATH, validateUndo, (c) =>
    undoListOperationHandler(c, c.req.valid('json'), new Date().toISOString()),
  )
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
  .delete(LIST_ITEM_PATH, deleteListItemHandler)
  /**
   * The optional bridge to Activities (P3-13). Creating, so it takes an `Idempotency-Key`;
   * no `If-Match`, because it edits nothing — it adds a Plan and the caller's pointer beside
   * an item it leaves byte-identical.
   */
  .post(SCHEDULE_LIST_ITEM_PATH, validateSchedule, (c) =>
    scheduleListItemHandler(c, c.req.valid('json'), new Date().toISOString()),
  );
