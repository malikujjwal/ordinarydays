import { Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListOverviewProps {
  count: string;
}

/** Muted item-count information immediately below the open List title. */
export function ListOverview({ count }: ListOverviewProps) {
  const theme = useTheme();

  return (
    <View
      testID="list-overview"
      style={{
        paddingBottom: theme.space[2],
      }}
    >
      <Text variant="footnote" color="textSecondary">
        {count}
      </Text>
    </View>
  );
}
