import { IconTile, Plus, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface ListAddRowProps {
  listName: string;
  onPress: () => void;
}

/** Final content row for a populated List; it stays inside the List measure. */
export function ListAddRow({ listName, onPress }: ListAddRowProps) {
  const theme = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel="Add an item"
      onPress={onPress}
      testID="list-add-item"
      style={{
        minHeight: theme.layout.rowMinHeight,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space[3],
        paddingVertical: theme.space[2],
      }}
    >
      <IconTile icon={Plus} tint="task" size={36} treatment="dashed" />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="bodyStrong" color="textAction">
          Add an item
        </Text>
        <Text variant="footnote" color="textSecondary" numberOfLines={2}>
          to {listName}
        </Text>
      </View>
    </Touchable>
  );
}
