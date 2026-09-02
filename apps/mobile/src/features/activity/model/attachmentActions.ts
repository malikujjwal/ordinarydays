import type { Activity, Attachment } from '@od/shared/types';
import type { Confirmation } from '@/components/ConfirmDialog';

/**
 * The pure decisions behind the attachment actions (P3-42): who may act, what the hero is,
 * and what the delete confirmation says. No I/O, no React.
 */

/**
 * `Set as cover` and `Delete` are the owner's (`plans-and-lists.md` §2.1 row 8). A
 * participant sees neither — absent, not disabled — and so does a viewer the app has not
 * identified yet: an unknown viewer is not the owner.
 */
export function canManageAttachments(
  activity: { readonly ownerId?: Activity['ownerId'] | undefined },
  viewerUserId: string | undefined,
): boolean {
  return (
    viewerUserId !== undefined &&
    activity.ownerId !== undefined &&
    viewerUserId === activity.ownerId
  );
}

/**
 * The hero renders only when `primaryAttachmentId` names one of the plan's own attachments
 * (§2.2). A stale id — the cover deleted, the list not yet refetched — resolves to nothing
 * rather than to a broken image.
 */
export function resolveHero(
  primaryAttachmentId: string | undefined,
  attachments: readonly Attachment[],
): Attachment | undefined {
  if (primaryAttachmentId === undefined) return undefined;
  return attachments.find(
    (attachment) => attachment.attachmentId === primaryAttachmentId,
  );
}

/**
 * Deleting a photo confirms, in the §1a.1 shape, naming the object — and says when it is
 * the cover, because that is the one extra thing that disappears. No undo (§4.1).
 */
export function deleteAttachmentConfirmation(input: {
  position: number;
  total: number;
  isCover: boolean;
}): Confirmation {
  const photo = `Photo ${input.position} of ${input.total}`;
  const removes = [`${photo} will be removed`];
  if (input.isCover)
    removes.push('It is the cover, so the plan will have none until you set another');
  return {
    heading: `Delete ${photo.toLowerCase()}?`,
    removesLead: 'This removes:',
    removes,
    keeps: 'Everything else on the plan stays.',
    summary: input.isCover
      ? 'This cannot be undone. It is the cover, so the plan will have none until you set another.'
      : 'This cannot be undone.',
    confirmLabel: 'Delete photo',
    consequences: [
      { kind: 'removed', text: `${photo} will be removed` },
      ...(input.isCover
        ? [{ kind: 'removed' as const, text: 'The cover is cleared' }]
        : []),
      { kind: 'kept', text: 'Everything else on the plan stays' },
    ],
  };
}

/** The additive change gets the standard six-second undo (§1a.1, §4.1). */
export const COVER_SET_MESSAGE = 'Cover set';
