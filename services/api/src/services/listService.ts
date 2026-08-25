import type { List } from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { Page } from '../repositories/base.js';
import {
  deleteList,
  getListMeta,
  getListMetaForDeletion,
  ListReadFenceError,
  listItems,
  listListsForUser,
} from '../repositories/listRepository.js';
import { assertListAccess } from './authz.js';
import { type HydratedListItem, hydrateViewerLinks } from './listItemService.js';
import { drainListWork, withListWorkDrain } from './listMutationService.js';
import { profileDefaultToClear } from './listSlotService.js';

/**
 * The read and delete halves of Lists CRUD (`phase-03` §P3-05); creation is
 * `listCreationService.ts`, and items, settings and undo arrive with P3-08 to P3-10.
 *
 * Every read of a list partition goes through `assertListAccess` first: the exact caller
 * pointer is the grant, a stranger gets `404`, and the repository refuses to touch the
 * canonical partition without the grant object that read produced
 * (`security-privacy.md` §1 row 4a).
 */

const LIST_NOT_FOUND = 'List not found.';

/** Pattern 7 behind `GET /v1/lists`: the caller's page of current Lists, pointer-ordered. */
export async function listLists(userId: string, cursor?: string): Promise<Page<List>> {
  const page = await listListsForUser(userId, cursor);
  return {
    items: page.items.map((entry) => entry.list),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export interface ListDetailProjection {
  readonly list: List;
  readonly items?: HydratedListItem[];
  readonly nextCursor?: string;
}

/**
 * `GET /v1/lists/:id` — META alone, or pattern 8b's fenced first page with the caller-only
 * link join.
 *
 * With `includeItems`, the repository's fenced read supplies the page; the caller's link
 * rows are then batch-read for exactly those item ids, and each surviving link is kept only
 * after ordinary Activity authorisation (`assertActivityAccess`, `read`). A stale pointer —
 * its Activity deleted or no longer readable — is omitted rather than serialised as a dead
 * link (`api-contract.md` §2.7); the cleanup queue is P3-15's.
 *
 * A repair or migration marker is **drained once** before the fence failure is allowed to
 * become the retryable `503`, which is what §2.7 requires of every item read: a client that
 * arrives while somebody else's bounded work is outstanding finishes it and gets its page,
 * rather than bouncing until whoever started the work comes back. A `rankVersion` that moved
 * between the two META reads is not drainable and falls straight through to the `503`.
 */
export async function getListDetail(
  userId: string,
  listId: string,
  includeItems: boolean,
): Promise<ListDetailProjection> {
  const access = await assertListAccess(userId, listId, 'read');

  if (!includeItems) {
    const list = await getListMeta(userId, listId, access.index);
    if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
    return { list };
  }

  const page = await withListWorkDrain(userId, listId, access.index, async () => {
    const fenced = await listItems(userId, listId, access.index);
    if (fenced === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
    return fenced;
  });

  /**
   * The one implementation of the viewer-link rule, shared with the item page (P3-14).
   *
   * This projection had its own copy — the same batch read, the same access check, the same
   * omit-on-`not_found` — sitting beside `hydrateViewerLinks`, whose doc comment already
   * claimed the two were one. They agreed, which is the only reason nothing had gone wrong;
   * they would not have stayed agreeing, and this is a rule the security model rests on.
   * `page.itemIds` is `page.items.map((item) => item.itemId)`, so nothing is lost by deriving
   * the ids there instead.
   */
  return {
    list: page.list,
    items: await hydrateViewerLinks(userId, listId, access.index, page.items),
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/**
 * `DELETE /v1/lists/:id` — owner only, no `If-Match`, safe to retry.
 *
 * The META read here deliberately ignores the deletion tombstone, so a retry after a crash
 * mid-cascade resumes it rather than answering `404` while child rows survive; once the
 * final transaction has removed the pointer, a second call is `404` from the access check.
 *
 * When the list holds a `slot`, the repository always attempts to clear the caller's
 * `defaultLists[slot]` in the same transaction as the META removal, conditioned on that
 * slot naming exactly this list. No profile pre-read decides it — a stale read that missed
 * a concurrent selection would wrongly skip the cleanup — and a slot holding any other
 * value, including a newer choice from another device, fails only that item and survives
 * (P3-12's read-side guard remains the belt to these braces).
 *
 * A rank repair or behaviour migration holds the same gate every list-partition write
 * condition-checks, so deleting through one would fail that condition and surface as a bare
 * `409` — "somebody edited this" for a list that is merely mid-migration. A delete is a list
 * mutation like any other (`api-contract.md` §2.7), so it drains what it can first and answers
 * the retryable `503` when work remains, then re-reads the row it is about to remove.
 */
export async function removeList(
  userId: string,
  listId: string,
  now: string,
): Promise<string> {
  const access = await assertListAccess(userId, listId, 'owner');
  if (!(await drainListWork(userId, listId, access.index, now))) {
    throw new ListReadFenceError();
  }
  const list = await getListMetaForDeletion(userId, listId, access.index);
  if (list === undefined) throw new AppError('not_found', LIST_NOT_FOUND);
  const profileDefault = profileDefaultToClear(list);

  await deleteList(userId, listId, access.index, {
    now,
    expectedUpdatedAt: list.updatedAt,
    ...(list.sourceActivityId === undefined
      ? {}
      : { sourceActivityId: list.sourceActivityId }),
    ...(profileDefault === undefined ? {} : { clearProfileDefault: profileDefault }),
  });

  return listId;
}
