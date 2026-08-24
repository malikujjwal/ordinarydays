import { zValidator } from '@hono/zod-validator';
import { createListInput, listDetailQuery, listListQuery } from '@od/shared/schemas';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { createListHandler } from '../handlers/createList.js';
import { DELETE_LIST_PATH, deleteListHandler } from '../handlers/deleteList.js';
import { GET_LIST_PATH, getListHandler } from '../handlers/getList.js';
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
  .delete(DELETE_LIST_PATH, deleteListHandler);
