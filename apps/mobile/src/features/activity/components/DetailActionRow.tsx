import { ChevronRight, Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

export interface DetailActionRowProps {
  title: string;
  hint: string;
  onPress: () => void;
  testID: string;
}

/** A bottom detail action using the same measure and rhythm as capability rows. */
export function DetailActionRow({ title, hint, onPress, testID }: DetailActionRowProps) {
  const theme = useTheme();

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      <Touchable
        square={false}
        accessibilityRole="button"
        accessibilityLabel={title}
        onPress={onPress}
        testID={testID}
      >
        <View
          style={{
            minHeight: theme.layout.rowMinHeight,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space[4],
          }}
        >
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong" color="textPrimary">
              {title}
            </Text>
          </View>
          <Text variant="footnote" color="textSecondary">
            {hint}
          </Text>
          <ChevronRight size={20} color={theme.colors.textSecondary} />
        </View>
      </Touchable>
    </View>
  );
}
