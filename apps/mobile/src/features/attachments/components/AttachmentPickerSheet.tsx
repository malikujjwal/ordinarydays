import type { Attachment } from '@od/shared/types';
import { Button, Sheet } from '@od/ui';
import { AttachmentPicker } from '@/components/AttachmentPicker';
import { useAttachmentUpload } from '@/hooks/useAttachmentUpload';

/**
 * `Add a photo` from a plan's ATTACHMENTS section (P3-41). Composed at the activity route —
 * features may not import each other — with the plan's id, so every picked image runs the
 * whole chain and is linked on confirm. `onConfirmed` is the route's cue to refetch the
 * detail; the row here already says `Added`.
 */
export interface AttachmentPickerSheetProps {
  open: boolean;
  activityId: string;
  onClose: () => void;
  onConfirmed: (attachment: Attachment) => void;
}

export function AttachmentPickerSheet({
  open,
  activityId,
  onClose,
  onConfirmed,
}: AttachmentPickerSheetProps) {
  const controller = useAttachmentUpload({ activityId, onConfirmed });

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a photo"
      detent="fit"
      // Closing mid-upload leaves the chain running; the confirm still lands and refetches.
      actions={
        <Button
          label="Done"
          size="lg"
          fullWidth
          onPress={onClose}
          testID="attachment-sheet-done"
        />
      }
      testID="attachment-sheet"
    >
      <AttachmentPicker controller={controller} doneLabel="Added" />
    </Sheet>
  );
}
