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

/**
 * The author rule as a **runtime check on one object**, not a comment and not a union.
 *
 * `authorUserId` must be present on a `user` entry and absent on a `system` one. As a lone
 * optional field it was neither: a system row carrying an author parsed happily, which would
 * let P3-40 render a name on a record nobody wrote, and a user row *without* one parsed too,
 * leaving an entry whose delete nobody could ever authorise.
 *
 * A discriminated union is the obvious spelling and is **not** available here. Forbidding a
 * field needs `z.undefined()` in the system arm, which the OpenAPI generator cannot render
 * ("Unknown zod object type"), and a merely-omitted field would be stripped rather than
 * refused — enforcing nothing. Making the arm `.strict()` fails differently: this schema also
 * parses **stored rows**, which carry storage attributes an exact object would reject.
 *
 * So: one object, unknown keys stripped as every other stored shape strips them, and the
 * pairing checked where both fields are in scope.
 */
export const activityUpdate = z
  .object({
    updateId: ulidId('upd'),
    activityId: ulidId('act'),
    kind: activityUpdateKind,
    authorUserId: userId.optional(),
    body: z.string().min(1).max(MAX_UPDATE_BODY_LEN),
    createdAt: z.iso.datetime(),
    schemaVersion: z.literal(1),
  })
  .check((ctx) => {
    const { kind, authorUserId } = ctx.value;
    if (kind === 'user' && authorUserId === undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['authorUserId'],
        message: 'A user entry must name its author.',
      });
    }
    if (kind === 'system' && authorUserId !== undefined) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['authorUserId'],
        message: 'A system entry has no author.',
      });
    }
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
 * write it just made. Returning the authoritative value lets P3-40 move the row immediately
 * and treat a later, staler page as reconciliation rather than truth.
 */
export const postActivityUpdateResult = z
  .object({ update: activityUpdate, lastActivityAt: z.iso.datetime() })
  .meta({ id: 'PostActivityUpdateResult' });

/** One newest-first page. `cursor` is absent when the feed ends here. */
export const activityUpdatePage = z
  .object({ updates: z.array(activityUpdate), cursor: z.string().min(1).optional() })
  .meta({ id: 'ActivityUpdatePage' });

/** The self-describing acknowledgement returned by the update DELETE endpoint. */
export const deletedActivityUpdate = z
  .object({ updateId: ulidId('upd') })
  .meta({ id: 'DeletedActivityUpdate' });

export type ActivityUpdateKind = z.infer<typeof activityUpdateKind>;
export type ActivityUpdate = z.infer<typeof activityUpdate>;
export type PostActivityUpdateInput = z.infer<typeof postActivityUpdateInput>;
export type PostActivityUpdateResult = z.infer<typeof postActivityUpdateResult>;
export type ActivityUpdatePage = z.infer<typeof activityUpdatePage>;
export type DeletedActivityUpdate = z.infer<typeof deletedActivityUpdate>;
