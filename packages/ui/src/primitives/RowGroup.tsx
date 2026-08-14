import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/index';
import { Text } from './Text';

export interface RowGroupProps {
  /** The tracked uppercase caption above the group, when it needs naming. */
  label?: string;
  children: ReactNode;
  testID?: string;
}

/**
 * A ruled list of rows, and the one place that answers "where does the divider go".
 *
 * Rows carry a **bottom** hairline, so a group closes itself on its last row. Built the other
 * way — top rules plus a closing rule on the container — the gap between two groups rendered as
 * two horizontal lines with an empty band trapped between them, which reads as a mistake rather
 * than as a grouping. That bug appeared twice in two different screens before this existed.
 *
 * The caption is `caption` in `textMuted`: the frames' tracked uppercase section label.
 */
export function RowGroup({ label, children, testID }: RowGroupProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.space[3] }} testID={testID}>
      {label === undefined ? null : (
        <Text variant="caption" color="textMuted">
          {label}
        </Text>
      )}
      <View>{children}</View>
    </View>
  );
}
