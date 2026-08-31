import { GripVertical, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListOverviewProps {
  count: string;
}

/** Muted information that explains the open List's content and persistent handles. */
export function ListOverview({ count }: ListOverviewProps) {
  const theme = useTheme();

  return (
    <View
      testID="list-overview"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        columnGap: theme.space[4],
        rowGap: theme.space[2],
        paddingBottom: theme.space[2],
      }}
    >
      <Text variant="footnote" color="textSecondary">
        {count}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1] }}>
        <GripVertical size={16} color={theme.colors.textSecondary} />
        <Text variant="footnote" color="textSecondary">
          Drag handles to reorder
        </Text>
      </View>
    </View>
  );
}
