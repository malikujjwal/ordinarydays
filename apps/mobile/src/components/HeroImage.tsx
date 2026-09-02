import type { Attachment } from '@od/shared/types';
import { Touchable, useMotion, useTheme } from '@od/ui';
import { Image } from 'expo-image';
import { mediaUrlFor } from '@/lib/mediaUrl';

/**
 * The plan's cover (P3-42, `plans-and-lists.md` §2.1 row 1, §2.2).
 *
 * Renders only when the plan has a `primaryAttachmentId` that resolves to one of its own
 * attachments, and collapses to nothing otherwise — never a broken image, never an empty
 * frame. Tapping it opens the viewer at the cover (§3.3). The image is read by key against
 * the media origin (ADR-023); the row stores no URL.
 *
 * **No second announcement of the plan title** (§7.3): the accessible name is `Cover photo`,
 * and the title is announced once, by the heading under it.
 */
export interface HeroImageProps {
  attachment: Attachment | undefined;
  onPress: () => void;
  testID?: string;
}

/** The mock's drawn height; the frame is `radius.lg`, one step below a sheet's corner. */
export const HERO_HEIGHT = 160;

export function HeroImage({
  attachment,
  onPress,
  testID = 'hero-image',
}: HeroImageProps) {
  const theme = useTheme();
  const motion = useMotion();
  if (attachment === undefined) return null;

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel="Cover photo"
      accessibilityHint="Opens the photo viewer"
      onPress={onPress}
      testID={testID}
    >
      <Image
        source={{ uri: mediaUrlFor(attachment.key) }}
        accessibilityIgnoresInvertColors
        contentFit="cover"
        recyclingKey={attachment.attachmentId}
        transition={motion.duration.base}
        style={{
          width: '100%',
          height: HERO_HEIGHT,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.surfaceSunken,
        }}
        testID={`${testID}-picture`}
      />
    </Touchable>
  );
}
