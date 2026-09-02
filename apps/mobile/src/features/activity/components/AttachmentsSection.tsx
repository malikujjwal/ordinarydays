import type { Attachment } from '@od/shared/types';
import { useTheme } from '@od/ui';
import { View } from 'react-native';
import { ActionRow } from '@/features/activity/components/ActionRow';
import { SectionFrame } from '@/features/activity/components/SectionFrame';

/**
 * The ATTACHMENTS section (P3-37, P3-41). Placeholder tiles until P3-42 brings the viewer:
 * the section exists because content exists, but media bytes are served by unguessable key
 * and nothing on this screen may fabricate a URL for one. The 56 pt tile is the mock's
 * drawn size, replaced when P3-42's real thumbnails land. A populated section carries its
 * own `+ Add photo` (P3-41), like PREP and LISTS carry theirs; the chip row offers `Photo`
 * only while the section is empty.
 */
export interface AttachmentsSectionProps {
  attachments: readonly Attachment[];
  /** Opens the picker with this plan fixed. Absent leaves the affordance out. */
  onAdd?: () => void;
}

export function AttachmentsSection({ attachments, onAdd }: AttachmentsSectionProps) {
  const theme = useTheme();
  return (
    <SectionFrame
      label="Attachments"
      trailing={String(attachments.length)}
      testID="section-attachments"
    >
      <View style={{ flexDirection: 'row', gap: theme.space[2], overflow: 'hidden' }}>
        {attachments.slice(0, 4).map((attachment) => (
          <View
            key={attachment.attachmentId}
            style={{
              width: 56,
              height: 56,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.surfaceSunken,
            }}
            testID={`attachment-tile-${attachment.attachmentId}`}
          />
        ))}
      </View>
      {onAdd === undefined ? null : (
        <ActionRow
          label="+ Add photo"
          accessibilityLabel="Add photo"
          onPress={onAdd}
          testID="attachments-add"
        />
      )}
    </SectionFrame>
  );
}
