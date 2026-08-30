import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListOverviewProps {
  count: string;
}

/** The compact, computed content count directly below the List header. */
export function ListOverview({ count }: ListOverviewProps) {
  const theme = useTheme();

  return (
    <View
      testID="list-overview"
      style={{
        alignItems: 'flex-start',
        paddingBottom: theme.space[2],
      }}
    >
      <Text variant="footnote" color="textSecondary">
        {count}
      </Text>
    </View>
  );
}
