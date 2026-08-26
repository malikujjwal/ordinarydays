import { z } from 'zod';
import { MAX_UPDATE_BODY_LEN } from '../constants.js';
import { ulidId, userId } from './common.js';

/**
 * The plan's activity feed (`api-contract.md` §2.5, `data-model.md` §3.1 and §4.10).
 *
 * Two kinds of entry share one row shape and one sort order, because they share one purpose:
 * the feed is a record of what has happened to this plan, and "Alice posted a note" and "the
 * time changed to 8 PM" are both that. What separates them is who may write one and who may
 * remove it — see {@link activityUpdateKind}.
 */

/**
 * `user` is somebody typing; `system` is the server recording an event.
 *
 * A client may never send either. `kind` is server-authored on both paths, which is what
 * makes a `system` entry trustworthy: if a caller could claim the kind, the de-emphasised
 * "the time changed to 8 PM" row would be forgeable, and the feed would stop being a record.
 */
export const activityUpdateKind = z.enum(['user', 'system']);

export const activityUpdate = z
  .object({
    updateId: ulidId('upd'),
    activityId: ulidId('act'),
    kind: activityUpdateKind,
    /**
     * **Present on `user` entries only.** A system entry has no author because nobody wrote
     * it; carrying the acting user would misattribute a record of what happened to the person
     * who happened to trigger it, and P3-39 renders system rows with no name at all.
     */
    authorUserId: userId.optional(),
    body: z.string().min(1).max(MAX_UPDATE_BODY_LEN),
    createdAt: z.iso.datetime(),
    schemaVersion: z.literal(1),
  })
  .meta({ id: 'ActivityUpdate' });

/**
 * What a client may post: the body, and nothing else.
 *
 * **Strict**, and that is the whole schema's job. `kind`, `authorUserId` and `createdAt` are
 * server-authored, and a permissive object would let a caller forge a system entry, attribute
 * a note to somebody else, or backdate a row into the middle of a feed that sorts on exactly
 * that value. Strict turns each of those into `validation_failed` rather than into a silently
 * ignored field, so the refusal is visible to the client that tried.
 */
export const postActivityUpdateInput = z
  .object({ body: z.string().min(1).max(MAX_UPDATE_BODY_LEN) })
  .strict()
  .meta({ id: 'PostActivityUpdateInput' });

/**
 * `POST` returns the stored entry **and** the plan's new `lastActivityAt`.
 *
 * The timestamp is not a convenience. `#P` sorts on it and GSI1 is eventually consistent, so
 * a client that refetched to find its new position could read a projection older than the
 * write it just made. Returning the authoritative value lets P3-39 move the row immediately
 * and treat a later, staler page as reconciliation rather than truth.
 */
export const postActivityUpdateResult = z
  .object({ update: activityUpdate, lastActivityAt: z.iso.datetime() })
  .meta({ id: 'PostActivityUpdateResult' });

/** One newest-first page. `cursor` is absent when the feed ends here. */
export const activityUpdatePage = z
  .object({ updates: z.array(activityUpdate), cursor: z.string().min(1).optional() })
  .meta({ id: 'ActivityUpdatePage' });

export type ActivityUpdateKind = z.infer<typeof activityUpdateKind>;
export type ActivityUpdate = z.infer<typeof activityUpdate>;
export type PostActivityUpdateInput = z.infer<typeof postActivityUpdateInput>;
export type PostActivityUpdateResult = z.infer<typeof postActivityUpdateResult>;
export type ActivityUpdatePage = z.infer<typeof activityUpdatePage>;
