import type { Attachment } from '@od/shared/types';
import {
  IconButton,
  interactionTiming,
  MoreHorizontal,
  Touchable,
  useTheme,
} from '@od/ui';
import { Image } from 'expo-image';
import { Platform, View } from 'react-native';
import { ActionRow } from '@/features/activity/components/ActionRow';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import { mediaUrlFor } from '@/lib/mediaUrl';

/**
 * The ATTACHMENTS section (P3-37, P3-41, P3-42). Real thumbnails, read by key against the
 * media origin (ADR-023 — the row stores no URL). Tap opens the viewer at that image;
 * long-press offers `Set as cover` / `Delete` to the owner and nobody else (§2.1 row 8 —
 * absent, not disabled, so `onActions` is simply not passed for a participant). A pointer
 * does not long-press, so on web the same actions sit behind a small `⋯` on the tile
 * (`interaction-contract.md` §7's pointer equivalents), which is also what a keyboard and
 * the tests reach. The 56 pt
 * tile is the mock's drawn size. A populated section carries its own `+ Add photo` (P3-41);
 * the chip row offers `Photo` only while the section is empty.
 */
export interface AttachmentsSectionProps {
  attachments: readonly Attachment[];
  /** The current cover, labelled so a screen reader hears which tile it is. */
  coverAttachmentId?: string | undefined;
  /** Opens the viewer at `index`. Absent leaves the tiles inert. */
  onOpen?: (index: number) => void;
  /** Long-press: `Set as cover` / `Delete`. Owner only — absent for anyone else. */
  onActions?: (attachment: Attachment) => void;
  /** Opens the picker with this plan fixed. Absent leaves the affordance out. */
  onAdd?: () => void;
}

export function AttachmentsSection({
  attachments,
  coverAttachmentId,
  onOpen,
  onActions,
  onAdd,
}: AttachmentsSectionProps) {
  const theme = useTheme();
  const total = attachments.length;
  return (
    <SectionFrame
      label="Attachments"
      trailing={String(total)}
      testID="section-attachments"
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {attachments.map((attachment, index) => {
          const isCover = attachment.attachmentId === coverAttachmentId;
          const label = `Photo ${index + 1} of ${total}${isCover ? ', cover' : ''}`;
          const tile = (
            <Image
              source={{ uri: mediaUrlFor(attachment.key) }}
              accessibilityIgnoresInvertColors
              contentFit="cover"
              recyclingKey={attachment.attachmentId}
              style={{
                width: 56,
                height: 56,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surfaceSunken,
                ...(isCover ? { borderWidth: 2, borderColor: theme.colors.accent } : {}),
              }}
              testID={`attachment-thumbnail-${attachment.attachmentId}`}
            />
          );
          if (onOpen === undefined) {
            return (
              <View
                key={attachment.attachmentId}
                testID={`attachment-tile-${attachment.attachmentId}`}
              >
                {tile}
              </View>
            );
          }
          return (
            <View
              key={attachment.attachmentId}
              style={{ alignItems: 'center', gap: theme.space[1] }}
            >
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={
                  onActions === undefined
                    ? 'Opens the photo viewer'
                    : 'Opens the photo viewer. Long press for more options'
                }
                onPress={() => onOpen(index)}
                {...(onActions === undefined
                  ? {}
                  : {
                      onLongPress: () => onActions(attachment),
                      delayLongPress: interactionTiming.longPress,
                    })}
                testID={`attachment-tile-${attachment.attachmentId}`}
              >
                {tile}
              </Touchable>
              {/* Beside the tile, never over it: a control laid on top would intercept the
                  tap that opens the viewer. */}
              {onActions !== undefined && Platform.OS === 'web' ? (
                <IconButton
                  icon={MoreHorizontal}
                  label={`Photo ${index + 1} of ${total} options`}
                  onPress={() => onActions(attachment)}
                  testID={`attachment-options-${attachment.attachmentId}`}
                />
              ) : null}
            </View>
          );
        })}
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
