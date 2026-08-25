import type { ScheduleListItemInput } from '@od/shared/schemas';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { scheduleListItem } from '../services/listScheduleService.js';
import { idempotentJson } from './idempotentResponse.js';
import { toListItem, toListItemLink } from './toList.js';

/**
 * `POST /v1/lists/:id/items/:itemId/schedule` (`api-contract.md` §2.7, `phase-03` §P3-13).
 *
 * `201`, because it creates. The receipt is built from the committed result rather than
 * before it, so a replay returns a body naming the Plan that was actually written — the
 * lesson P3-08 learned when a prebuilt receipt named an item that never existed.
 *
 * `item` and `viewerLink` are projected: `toListItem` drops `itemRevision`, the storage-only
 * mutation fence, and `toListItemLink` serialises the caller's own pointer and never another
 * viewer's (ADR-034). The item is the source row **unchanged**, which is what lets a client
 * see that the bridge linked rather than duplicated.
 *
 * The activity goes back as it stands, for the reason `createActivity`'s handler records: on
 * the create path it is the domain object the service built field by field and has never been
 * near DynamoDB, and on the replay path it came through `parseActivity`, whose non-strict
 * schema strips `pk`, `sk` and `entity` rather than carrying them.
 */
export const SCHEDULE_LIST_ITEM_PATH = '/:id/items/:itemId/schedule';

export async function scheduleListItemHandler(
  c: Context<AppEnv, typeof SCHEDULE_LIST_ITEM_PATH>,
  input: ScheduleListItemInput,
  now: string,
): Promise<Response> {
  const userId = requireUserId(c);

  return idempotentJson(c, 201, (receiptFor) =>
    scheduleListItem(
      userId,
      c.req.param('id'),
      c.req.param('itemId'),
      input,
      now,
      (result) =>
        receiptFor({
          activity: result.activity,
          item: toListItem(result.item),
          viewerLink: toListItemLink(result.viewerLink),
        }),
    ),
  );
}
