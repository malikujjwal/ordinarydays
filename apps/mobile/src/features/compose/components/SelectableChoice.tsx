import { Text, Touchable, useTheme } from '@od/ui';
import { View } from 'react-native';

/**
 * An inline chooser row that can be selected without navigating away.
 *
 * {@link ChooserRow} is a navigation control and therefore has no selected state.
 * Global Add keeps Task / Plan / Add list and the Plan kinds on one sheet, so those
 * choices are toggles: nothing starts pressed, and `aria-pressed` is the spoken state.
 */
export interface SelectableChoiceProps {
  label: string;
  subtitle: string;
  selected: boolean;
  onPress: () => void;
  /** Chip-style: still visible, not pressable, spoken as disabled. */
  disabled?: boolean;
  testID?: string;
}

export function SelectableChoice({
  label,
  subtitle,
  selected,
  onPress,
  disabled = false,
  testID,
}: SelectableChoiceProps) {
  const theme = useTheme();

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${subtitle}`}
      accessibilityState={{ selected, disabled }}
      aria-pressed={selected}
      disabled={disabled}
      onPress={onPress}
      {...(testID === undefined ? {} : { testID })}
      style={{
        paddingVertical: theme.space[4],
        paddingHorizontal: theme.space[4],
        borderRadius: theme.radius.md,
        backgroundColor: selected
          ? theme.colors.accentSurface
          : theme.colors.surfaceSunken,
        borderWidth: 1,
        borderColor: selected ? theme.colors.accentBorder : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{ gap: theme.space[1] }}>
        <Text variant="bodyStrong" color="textPrimary">
          {label}
        </Text>
        <Text variant="footnote" color="textSecondary">
          {subtitle}
        </Text>
      </View>
    </Touchable>
  );
}
