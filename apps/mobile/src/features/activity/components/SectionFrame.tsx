import { SectionHeader, Text, Touchable, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';

/**
 * One Plan-detail section's frame (P3-37, `plans-and-lists.md` §2.1 amended 2026-08-25):
 * caption header with a trailing figure, then its rows. Sections exist only once they hold
 * something; the frame never renders an empty heading because no section mounts it empty.
 */
export interface SectionFrameProps {
  label: string;
  trailing?: string;
  /** Spoken name for a tappable trailing control; defaults to `trailing`. */
  trailingAccessibilityLabel?: string;
  onTrailingPress?: () => void;
  children: ReactNode;
  testID?: string;
}

export function SectionFrame({
  label,
  trailing,
  trailingAccessibilityLabel,
  onTrailingPress,
  children,
  testID,
}: SectionFrameProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} {...(testID === undefined ? {} : { testID })}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: theme.space[2],
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <SectionHeader title={label} />
        </View>
        {trailing === undefined ? null : onTrailingPress === undefined ? (
          <Text variant="footnoteStrong" color="textSecondary">
            {trailing}
          </Text>
        ) : (
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={trailingAccessibilityLabel ?? trailing}
            onPress={onTrailingPress}
            style={{
              minHeight: theme.layout.hitTarget,
              justifyContent: 'center',
              flexShrink: 1,
              maxWidth: '100%',
            }}
          >
            <Text variant="footnoteStrong" color="textAction">
              {trailing}
            </Text>
          </Touchable>
        )}
      </View>
      {children}
    </View>
  );
}
