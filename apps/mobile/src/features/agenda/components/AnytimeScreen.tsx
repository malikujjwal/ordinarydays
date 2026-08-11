import { Button, Skeleton, Text, useBreakpoint, useTheme } from '@od/ui';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export interface AnytimeScreenProps {
  onBack: () => void;
}

/** P2-19's registered loading stub. P2-39 replaces its body with the saved-task list. */
export function AnytimeScreen({ onBack }: AnytimeScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const compact = useBreakpoint() === 'compact';

  return (
    <View
      testID="anytime-screen"
      style={{ flex: 1, backgroundColor: theme.colors.surface }}
    >
      <View
        style={{
          width: '100%',
          alignSelf: 'center',
          // The cap is unconditional: it is harmless below 720 pt and prevents the static
          // compact render from flashing full-width before the web breakpoint hydrates.
          maxWidth: 720,
          paddingTop: insets.top + theme.space[3],
          paddingHorizontal: compact ? theme.space[5] : theme.space[7],
          gap: theme.space[3],
        }}
      >
        <Button label="Back" variant="ghost" onPress={onBack} testID="anytime-back" />
        <Text variant="display" color="textDisplay" accessibilityRole="header">
          Anytime
        </Text>
        <View testID="anytime-loading" style={{ paddingTop: theme.space[5] }}>
          <Skeleton shape="row" count={5} />
        </View>
      </View>
    </View>
  );
}
