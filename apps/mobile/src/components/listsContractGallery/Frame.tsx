import { Text, useTheme } from '@od/ui';
import type { ReactNode } from 'react';
import { View } from 'react-native';

export interface FrameProps {
  title: string;
  children: ReactNode;
}

/** Labelled gallery-only boundary around one production row. */
export function Frame({ title, children }: FrameProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.space[3] }}>
      <Text variant="sectionLabel" color="textSecondary">
        {title}
      </Text>
      {children}
    </View>
  );
}
