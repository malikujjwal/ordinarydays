import { ChevronRight, Row, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * One row of a chooser.
 *
 * A thin wrapper over `@od/ui`'s `Row`, and the reason it exists is the `accessibilityState`:
 * every chooser row is announced `not selected`, unconditionally. There is no `selected` prop
 * to pass. A component that could render a selected chooser row is a component that could
 * pre-select one, and the rule the choosers exist to enforce is that **nothing is selected**
 * (`interaction-contract.md` §1a.3).
 *
 * The chevron is decorative — the row's label is its accessible name — so it is hidden from
 * assistive technology rather than read as "chevron right".
 */
export interface ChooserRowProps {
  label: string;
  onPress: () => void;
  testID?: string;
}

export function ChooserRow({ label, onPress, testID }: ChooserRowProps) {
  const theme = useTheme();

  return (
    <Row
      title={label}
      onPress={onPress}
      {...(testID === undefined ? {} : { testID })}
      trailing={
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ChevronRight size={20} color={theme.colors.textSecondary} />
        </View>
      }
    />
  );
}
