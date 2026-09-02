import type { Attachment } from '@od/shared/types';
import {
  ChevronLeft,
  ChevronRight,
  Close,
  IconButton,
  Text,
  useMotion,
  useTheme,
} from '@od/ui';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Modal, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mediaUrlFor } from '@/lib/mediaUrl';

/**
 * The full-screen viewer behind a plan's thumbnails and its hero (P3-42, `plans-and-lists.md`
 * §2.1 rows 1 and 8, §3.3).
 *
 * Swipes between the activity's images (a paged horizontal list) and opens at whichever one
 * was tapped — the cover, from the hero. `Photo n of m` is both the caption and the accessible
 * name of each image; the previous/next controls exist for a keyboard and a pointer, where a
 * swipe is not a gesture anyone makes.
 *
 * The `Modal` carries no animation type (P3-26's finding): React Native Web only adds the
 * dialog role and runs its focus trap once its own animation ends, and that event never
 * fires. Mounted instantly, the viewer traps focus while open and returns it to the trigger
 * on close, which is §7.3's requirement and what the E2E accessibility scan sees.
 */
export interface AttachmentViewerProps {
  open: boolean;
  attachments: readonly Attachment[];
  /** Index into `attachments` to open at; clamped. */
  initialIndex: number;
  onClose: () => void;
  testID?: string;
}

export function AttachmentViewer({
  open,
  attachments,
  initialIndex,
  onClose,
  testID = 'attachment-viewer',
}: AttachmentViewerProps) {
  const theme = useTheme();
  const motion = useMotion();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const total = attachments.length;
  const clamp = useCallback(
    (index: number) => Math.min(Math.max(index, 0), Math.max(total - 1, 0)),
    [total],
  );
  const [index, setIndex] = useState(() => clamp(initialIndex));
  const list = useRef<FlatList<Attachment>>(null);

  // Reopening at a different image starts there, not where the last viewing left off.
  useEffect(() => {
    if (open) setIndex(clamp(initialIndex));
  }, [open, initialIndex, clamp]);

  const goTo = useCallback(
    (next: number) => {
      const target = clamp(next);
      setIndex(target);
      list.current?.scrollToIndex({ index: target, animated: !motion.reduced });
    },
    [clamp, motion.reduced],
  );

  if (!open || total === 0) return null;
  const caption = `Photo ${index + 1} of ${total}`;

  return (
    <Modal
      visible
      transparent={false}
      animationType="none"
      accessibilityLabel={caption}
      onRequestClose={onClose}
      testID={testID}
    >
      <View style={{ flex: 1, backgroundColor: theme.colors.scrim }}>
        <FlatList
          ref={list}
          data={attachments}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(attachment) => attachment.attachmentId}
          initialScrollIndex={index}
          getItemLayout={(_data, position) => ({
            length: width,
            offset: width * position,
            index: position,
          })}
          onMomentumScrollEnd={(event) =>
            setIndex(clamp(Math.round(event.nativeEvent.contentOffset.x / width)))
          }
          renderItem={({ item, index: position }) => (
            <View
              style={{ width, height, alignItems: 'center', justifyContent: 'center' }}
              testID={`${testID}-page-${position}`}
            >
              <Image
                source={{ uri: mediaUrlFor(item.key) }}
                accessibilityLabel={`Photo ${position + 1} of ${total}`}
                accessibilityIgnoresInvertColors
                contentFit="contain"
                recyclingKey={item.attachmentId}
                transition={motion.duration.base}
                style={{ width, height: height * 0.8 }}
                testID={`${testID}-image-${item.attachmentId}`}
              />
            </View>
          )}
          testID={`${testID}-pager`}
        />

        <View
          style={{
            position: 'absolute',
            top: insets.top + theme.space[2],
            left: theme.space[4],
            right: theme.space[4],
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text variant="subhead" color="inverse" testID={`${testID}-caption`}>
            {caption}
          </Text>
          <IconButton
            icon={Close}
            label="Close"
            onPress={onClose}
            testID={`${testID}-close`}
          />
        </View>

        {/* Pointer and keyboard navigation; a swipe does the same on touch. */}
        <View
          style={{
            position: 'absolute',
            bottom: theme.space[8],
            left: theme.space[4],
            right: theme.space[4],
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <IconButton
            icon={ChevronLeft}
            label="Previous photo"
            onPress={() => goTo(index - 1)}
            disabled={index === 0}
            testID={`${testID}-previous`}
          />
          <IconButton
            icon={ChevronRight}
            label="Next photo"
            onPress={() => goTo(index + 1)}
            disabled={index >= total - 1}
            testID={`${testID}-next`}
          />
        </View>
      </View>
    </Modal>
  );
}
