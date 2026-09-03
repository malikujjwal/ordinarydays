import { Button, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import type { ListsView } from '../hooks/useLists';

interface LoadMoreFailureProps {
  readonly failure: NonNullable<ListsView['loadMoreFailure']>;
}

export function LoadMoreFailure({ failure }: LoadMoreFailureProps) {
  const theme = useTheme();
  return (
    <View accessibilityRole="alert" style={{ gap: theme.space[3] }}>
      <Text variant="footnote" color="danger">
        {failure.message}
      </Text>
      {failure.requestId === undefined ? null : (
        <Text variant="footnote" color="textSecondary" selectable>
          {failure.requestId}
        </Text>
      )}
      <Button label="Retry loading lists" variant="secondary" onPress={failure.retry} />
    </View>
  );
}
