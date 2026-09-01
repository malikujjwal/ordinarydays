import type { Attachment } from '@od/shared/types';
import { useTheme } from '@od/ui';
import { View } from 'react-native';
import { SectionFrame } from '@/features/activity/components/SectionFrame';

/**
 * The ATTACHMENTS section (P3-37). Placeholder tiles until P3-41/P3-42 bring the picker and
 * viewer: the section exists because content exists, but media bytes are served by
 * unguessable key and nothing on this screen may fabricate a URL for one. The 56 pt tile is
 * the mock's drawn size, replaced when P3-42's real thumbnails land.
 */
export interface AttachmentsSectionProps {
  attachments: readonly Attachment[];
}

export function AttachmentsSection({ attachments }: AttachmentsSectionProps) {
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
    </SectionFrame>
  );
}
