import { deleteAttachment } from '@od/shared/client';
import type { PatchActivityInput } from '@od/shared/schemas';
import type { Attachment } from '@od/shared/types';
import { Button, Sheet, useTheme } from '@od/ui';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  COVER_SET_MESSAGE,
  deleteAttachmentConfirmation,
} from '@/features/activity/model/attachmentActions';
import { apiClient } from '@/lib/apiClient';
import { describeApiFailure } from '@/lib/apiFailure';
import { activityKey } from '@/lib/queryKeys';
import { getActiveNativeState } from '@/lib/sqlite/nativeState';
import { useToast } from '@/stores/toast';

/**
 * The long-press actions on a plan's photo (P3-42): `Set as cover` and `Delete`.
 *
 * - **Set as cover is additive** (§1a.1): it applies at once through the detail's own
 *   `patch` — which carries `If-Match` and the conflict path — and gets the standard
 *   six-second undo, which patches the previous cover back (or `null`).
 * - **Delete confirms** — deletions always do, even of one thing (§1a.1 rule 3) — in the
 *   §1a.1 shape naming the photo, with no undo (§4.1). Deleting the cover clears the hero:
 *   the server clears `primaryAttachmentId` in the same write (P3-22) and the refetch
 *   collapses the slot.
 *
 * Owner-only is the caller's decision: the screen passes `open` to the section only for the
 * owner, so a participant never reaches this sheet (absent, not disabled).
 */
export interface AttachmentActionsController {
  readonly open: (attachment: Attachment) => void;
  /** The sheet and the confirmation, rendered by the screen wherever it keeps its modals. */
  readonly sheet: ReactNode;
}

export function useAttachmentActions(input: {
  readonly activityId: string;
  readonly attachments: readonly Attachment[];
  readonly primaryAttachmentId: string | undefined;
  readonly patch: (patch: PatchActivityInput) => Promise<boolean>;
}): AttachmentActionsController {
  const { activityId, attachments, primaryAttachmentId, patch } = input;
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<Attachment | undefined>(undefined);
  const [confirmationRequested, setConfirmationRequested] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setTarget(undefined);
    setConfirmationRequested(false);
    setConfirming(false);
  }, []);

  const setCover = useCallback(async () => {
    if (target === undefined) return;
    const previous = primaryAttachmentId;
    const chosen = target.attachmentId;
    close();
    const applied = await patch({ primaryAttachmentId: chosen });
    if (!applied) return;
    useToast.getState().showUndo({
      message: COVER_SET_MESSAGE,
      onUndo: () => {
        void patch({ primaryAttachmentId: previous ?? null });
      },
      onCommit: () => {},
    });
  }, [close, patch, primaryAttachmentId, target]);

  const remove = useCallback(async () => {
    if (target === undefined) return;
    const removing = target;
    setBusy(true);
    try {
      const native = getActiveNativeState();
      if (native?.sync.deleteAttachment !== undefined) {
        await native.sync.deleteAttachment(activityId, removing.attachmentId);
      } else {
        await deleteAttachment(apiClient, activityId, removing.attachmentId);
        await queryClient.invalidateQueries({ queryKey: activityKey(activityId) });
      }
    } catch (error) {
      const failure = describeApiFailure(error, "Couldn't delete that photo.");
      close();
      useToast.getState().show({
        message: failure.message,
        tone: 'error',
        ...(failure.requestId === undefined ? {} : { requestId: failure.requestId }),
        action: {
          label: 'Retry',
          onPress: () => {
            setTarget(removing);
            setConfirming(true);
          },
        },
      });
      setBusy(false);
      return;
    }
    close();
    setBusy(false);
  }, [activityId, close, queryClient, target]);

  const position = target === undefined ? 0 : attachments.indexOf(target) + 1;
  const isCover = target !== undefined && target.attachmentId === primaryAttachmentId;

  const sheet = useMemo(
    () => (
      <>
        <Sheet
          open={target !== undefined && !confirmationRequested && !confirming}
          onClose={close}
          onClosed={() => {
            if (!confirmationRequested) return;
            setConfirmationRequested(false);
            setConfirming(true);
          }}
          title={position === 0 ? 'Photo' : `Photo ${position} of ${attachments.length}`}
          detent="fit"
          testID="attachment-actions"
        >
          <View style={{ gap: theme.space[3] }}>
            <Button
              label={isCover ? 'Already the cover' : 'Set as cover'}
              variant="secondary"
              fullWidth
              disabled={isCover}
              onPress={() => void setCover()}
              testID="attachment-set-cover"
            />
            <Button
              label="Delete"
              variant="dangerGhost"
              fullWidth
              onPress={() => setConfirmationRequested(true)}
              testID="attachment-delete"
            />
          </View>
        </Sheet>
        {target !== undefined && confirming ? (
          <ConfirmDialog
            open
            centred
            busy={busy}
            confirmation={deleteAttachmentConfirmation({
              position,
              total: attachments.length,
              isCover,
            })}
            onCancel={close}
            onConfirm={() => void remove()}
            testID="attachment-delete-confirm"
          />
        ) : null}
      </>
    ),
    [
      attachments.length,
      busy,
      close,
      confirmationRequested,
      confirming,
      isCover,
      position,
      remove,
      setCover,
      target,
      theme.space,
    ],
  );

  return useMemo(() => ({ open: setTarget, sheet }), [sheet]);
}
