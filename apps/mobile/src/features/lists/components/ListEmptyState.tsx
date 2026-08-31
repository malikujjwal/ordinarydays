import { Button, IconTile, List as ListIcon, Text, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListEmptyStateProps {
  body: string;
  onAdd?: () => void;
}

/** The one-action empty List state from §7.2b. */
export function ListEmptyState({ body, onAdd }: ListEmptyStateProps) {
  const theme = useTheme();

  return (
    <View
      testID="list-detail-empty"
      style={{
        alignItems: 'center',
        gap: theme.space[3],
        paddingTop: theme.space[8],
        paddingHorizontal: theme.space[6],
      }}
    >
      <IconTile icon={ListIcon} tint="custom" size={36} testID="list-detail-empty-icon" />
      <Text variant="heading" align="center">
        Start with one item
      </Text>
      <Text variant="subhead" color="textSecondary" align="center">
        {body}
      </Text>
      {onAdd === undefined ? null : (
        <View style={{ paddingTop: theme.space[2] }}>
          <Button label="Add item" variant="primary" onPress={onAdd} />
        </View>
      )}
    </View>
  );
}
