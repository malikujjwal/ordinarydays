import { SectionHeader, Text, useTheme } from '@od/ui';
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
  children: ReactNode;
  testID?: string;
}

export function SectionFrame({ label, trailing, children, testID }: SectionFrameProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[2] }} {...(testID === undefined ? {} : { testID })}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: theme.space[2],
        }}
      >
        <SectionHeader title={label} />
        {trailing === undefined ? null : (
          <Text variant="footnoteStrong" color="textSecondary">
            {trailing}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}
