import type { ScheduleListItemInput } from '@od/shared/schemas';
import type {
  Activity,
  ListItem,
  ListItemActivityLink,
  Reminder,
} from '@od/shared/types';
import { AppError } from '../lib/errors.js';
import type { IdempotencyReceipt } from '../lib/idempotency.js';
import {
  ActivityIdUnavailableError,
  activityFromPartition,
  createActivity,
  getActivityPartitionStrong,
} from '../repositories/activityRepository.js';
import { batchGetViewerLinks, getListItem } from '../repositories/listRepository.js';
import {
  deriveStatus,
  ID_UNAVAILABLE,
  recurrenceForCreate,
  SHARING_SOON,
  toSchedule,
} from './activityService.js';
import { assertListAccess } from './authz.js';

/**
 * `POST /v1/lists/:id/items/:itemId/schedule` — the optional bridge from a list item to a
 * Plan (`phase-03` §P3-13, `api-contract.md` §2.7, ADR-034).
 *
 * ## The one mistake this file exists to not make
 *
 * The item is **not** copied, moved, checked, hidden, or given an Activity id
 * (`agent-playbook.md` §6.8). Scheduling writes a new Activity carrying provenance back to
 * the item, plus one pointer for the caller. Nothing in this file writes an `ITEM#` row, and
 * the response returns the item unchanged so a caller can see that for itself.
 *
 * ## Nothing here infers what the user chose
 *
 * `creationTarget.type` is the Plan kind the user tapped and is the only thing that sets the
 * Activity's type. This service never reads `List.behaviour`, `templateKey` or any capability
 * to choose or pre-select it — a `watch` list does not make a `watch` Plan (`CLAUDE.md`
 * rule 2). `audience` is likewise required and never derived.
 *
 * ## It extends the create path rather than rebuilding a smaller one
 *
 * The derivations are imported from `activityService`, not restated: a second `deriveStatus`
 * or a second recurrence rule would eventually disagree with the first, and then a Plan made
 * from a list item would differ from the same Plan made from Add. The write is
 * `activityRepository.createActivity`'s transaction with one more row in it.
 */

/**
 * What the bridge produced, in domain terms.
 *
 * `item` is the **full** stored `ListItem`, not the response projection: the handler drops
 * `itemRevision` on its way out, and a service that returned the trimmed shape would be
 * deciding a serialisation question one layer too early.
 */
export interface ScheduleListItemResult {
  readonly activity: Activity;
  readonly item: ListItem;
  readonly viewerLink: ListItemActivityLink;
}

/** Until P3-22 lands the confirm-and-link path, an attachment cannot be honoured. */
const ATTACHMENTS_SOON = 'Attachments are coming soon.';

const ITEM_NOT_FOUND = 'List item not found.';

export async function scheduleListItem(
  userId: string,
  listId: string,
  itemId: string,
  input: ScheduleListItemInput,
  now: string,
  receiptFor?: (result: ScheduleListItemResult) => IdempotencyReceipt,
): Promise<ScheduleListItemResult> {
  /**
   * `write`, which is this codebase's spelling of §P3-13's "member": any member of the list
   * may plan an item, and the write lands in the list partition as their own `LNK#` pointer.
   * A reader cannot, because they cannot write that pointer.
   */
  const access = await assertListAccess(userId, listId, 'write');

  /**
   * Refused **before** the item read and before any write. A request naming people is a
   * request for a Plan this phase cannot make, and doing the work first would leave the
   * rejection depending on whether the item happened to exist.
   */
  if (input.audience.mode === 'selected_people') {
    throw new AppError('validation_failed', SHARING_SOON, [
      { path: 'audience.participants', message: SHARING_SOON },
    ]);
  }

  /**
   * A temporary guard on an accepted field, exactly like the participants one above, and
   * removed by P3-22. The schema takes `attachmentIds` so the contract and the client are
   * stable, but there is no confirm-and-link path yet — writing the Plan and dropping the
   * attachments would be the silent partial success the strict schemas exist to prevent.
   */
  if ((input.attachmentIds?.length ?? 0) > 0) {
    throw new AppError('validation_failed', ATTACHMENTS_SOON, [
      { path: 'attachmentIds', message: ATTACHMENTS_SOON },
    ]);
  }

  /**
   * The exact-item read from P3-04/P3-08. A missing or tombstoned item is `404`; a rank
   * repair or behaviour migration mid-flight raises P3-04's fence error, which surfaces as
   * the retryable `503` rather than being swallowed here.
   */
  const item = await getListItem(userId, listId, access.index, itemId);
  if (item === undefined) throw new AppError('not_found', ITEM_NOT_FOUND);

  const schedule = input.schedule === undefined ? undefined : toSchedule(input.schedule);
  const storedRecurrence = recurrenceForCreate(input.recurrence, schedule);

  const activity: Activity = {
    /**
     * The client's id, always — this route requires one (ADR-055). Identity only: ownership
     * still comes from the authenticated principal and status still from the schedule.
     */
    activityId: input.activityId,
    ownerId: userId,
    status: deriveStatus(input.schedule),
    objectKind: 'plan',
    /** The kind the user tapped, and nothing else decides it. */
    type: input.creationTarget.type,
    /**
     * The item's title, copied **once**, when the request omitted one. After this the two
     * titles are independent in both directions — a member who may rename a shared item must
     * never rename another member's private Plan (P3-14).
     */
    title: input.title ?? item.title,
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(storedRecurrence === undefined ? {} : { recurrence: storedRecurrence }),
    ...(input.location === undefined ? {} : { location: input.location }),
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    /** Provenance back to where this Plan came from. The item carries no pointer the other way. */
    listId,
    listItemId: itemId,
    details: input.details ?? { kind: input.creationTarget.type },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: now,
    lastActivityAt: now,
    updatedAt: now,
    schemaVersion: 1,
  } as Activity;

  /** Caller-owned, under the ids the device already armed locally (P2-57, ADR-055). */
  const reminders: Reminder[] = (input.reminders ?? []).map(
    (entry): Reminder => ({
      reminderId: entry.reminderId,
      activityId: activity.activityId,
      userId,
      offsetMinutes: entry.offsetMinutes,
      channel: 'push',
    }),
  );

  const viewerLink: ListItemActivityLink = {
    listId,
    itemId,
    viewerUserId: userId,
    activityId: activity.activityId,
    linkedAt: now,
  };

  const result: ScheduleListItemResult = { activity, item, viewerLink };

  try {
    await createActivity(userId, activity, {
      reminders: reminders.map((row) => ({
        reminderId: row.reminderId,
        offsetMinutes: row.offsetMinutes,
      })),
      listItemLink: viewerLink,
      ...(receiptFor === undefined ? {} : { idempotencyReceipt: receiptFor(result) }),
    });
  } catch (error) {
    if (error instanceof ActivityIdUnavailableError) {
      return await adoptOrConflict(
        userId,
        listId,
        itemId,
        input.activityId,
        access.index,
      );
    }
    throw error;
  }

  return result;
}

/**
 * The replay path, after the 24-hour idempotency receipt has expired.
 *
 * An Activity already standing at this id **with the same owner, list and item** is this
 * caller's earlier successful action: the first response was lost, not a second Plan
 * attempted. So it is returned as it stands and **nothing is rewritten** — least of all the
 * caller's current pointer, which may since have been replaced by a newer confirmed action
 * and must not be rolled back to this older Plan (§P3-13).
 *
 * Anything else is an id that is simply not available, answered with the metadata-free copy
 * the durable-create path uses everywhere: no owner, no entity, no distinction between taken
 * and tombstoned (`data-model.md` §8).
 */
async function adoptOrConflict(
  userId: string,
  listId: string,
  itemId: string,
  activityId: string,
  access: Parameters<typeof getListItem>[2],
): Promise<ScheduleListItemResult> {
  const existing = activityFromPartition(await getActivityPartitionStrong(activityId));
  if (
    existing === undefined ||
    existing.ownerId !== userId ||
    existing.listId !== listId ||
    existing.listItemId !== itemId
  ) {
    throw new AppError('conflict', ID_UNAVAILABLE);
  }

  const item = await getListItem(userId, listId, access, itemId);
  if (item === undefined) throw new AppError('not_found', ITEM_NOT_FOUND);

  /**
   * The caller's **current** pointer, which is the honest answer: it may name a newer Plan
   * than the one being adopted, and the client learns that from the response rather than from
   * a write that pretended otherwise.
   */
  const [current] = await batchGetViewerLinks(userId, listId, access, [itemId]);
  if (current === undefined) throw new AppError('conflict', ID_UNAVAILABLE);

  return { activity: existing, item, viewerLink: current };
}
