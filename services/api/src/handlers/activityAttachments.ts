import type { ConfirmAttachmentInput } from '@od/shared/types';
import type { Context } from 'hono';
import type { AppEnv } from '../app-env.js';
import { requireUserId } from '../middleware/identity.js';
import { confirmAttachment, deleteAttachment } from '../services/attachmentService.js';
import { idempotentJson } from './idempotentResponse.js';

/** The two activity-scoped attachment routes (`api-contract.md` §2.6, P3-22). */
export const ACTIVITY_ATTACHMENTS_PATH = '/:id/attachments';
export const ACTIVITY_ATTACHMENT_PATH = '/:id/attachments/:attachmentId';

/**
 * `POST /v1/activities/:id/attachments` — confirm an upload and link it.
 *
 * `201`, because the request creates the `ATT#` row that makes the image part of the plan.
 * A **re-confirm returns `201` with the existing row** rather than `200`: confirmation is
 * idempotent by resumption, and a client that lost its response and retried is entitled to
 * the same answer rather than to a status that says its retry was the odd one out.
 *
 * Its registry entry carries `mutates: true`, so the `Idempotency-Key` middleware applies.
 * The key matters less here than on most creating routes precisely because the operation is
 * already idempotent on its own id — but it is what keeps a replayed request from re-running
 * a `HeadObject`, a copy and a transaction to reach the answer it already has.
 *
 * `new Date()` at the edge, as every other route does: `coding-standards.md` §4.3 bans an
 * implicit clock inside anything that has to be testable.
 */
export async function confirmAttachmentHandler(
  c: Context<AppEnv, typeof ACTIVITY_ATTACHMENTS_PATH>,
  input: ConfirmAttachmentInput,
  now: string,
): Promise<Response> {
  const log = c.get('logger');
  return idempotentJson(c, 201, async (receiptFor) =>
    confirmAttachment(requireUserId(c), c.req.param('id'), input.attachmentId, now, {
      receiptFor,
      ...(log === undefined ? {} : { log }),
    }),
  );
}

/**
 * `DELETE /v1/activities/:id/attachments/:attachmentId`.
 *
 * `200` with the envelope rather than `204`, for the reason `deletedDevice` records: every
 * response carries `{ data, meta }` and a `204` has no body to carry it in. The body names
 * whether the cover was cleared by the same write, so a client can drop its hero without a
 * refetch.
 *
 * No `Idempotency-Key`: `DELETE` is idempotent by its own shape, and a repeat is `404`, which
 * for the caller means "already gone" — the answer it wanted.
 */
export async function deleteAttachmentHandler(
  c: Context<AppEnv, typeof ACTIVITY_ATTACHMENT_PATH>,
  now: string,
): Promise<Response> {
  const data = await deleteAttachment(
    requireUserId(c),
    c.req.param('id'),
    c.req.param('attachmentId'),
    now,
  );

  return c.json({ data, meta: { requestId: c.get('requestId') } });
}
