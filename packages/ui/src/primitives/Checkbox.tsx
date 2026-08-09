import { View } from 'react-native';
import { Check } from '../icons/index';
import { useTheme } from '../theme/index';
import { Touchable } from './Touchable';

/**
 * The one control that mutates from a row (`design-system.md` §6,
 * `interaction-contract.md` U1).
 *
 * 44 × 44 target, 24 × 24 visual. Checked is an **olive** fill with a white check — the
 * product's success colour is a garden colour, not a traffic light.
 *
 * It is its own accessibility element with `role="checkbox"` and a `checked` state, so a
 * screen reader announces "Gym, not completed" rather than reading a decorative glyph.
 */
export interface CheckboxProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  /** The accessible name — usually the row's title. */
  label: string;
  disabled?: boolean;
  testID?: string;
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled = false,
  testID,
}: CheckboxProps) {
  const theme = useTheme();
  const visual = 24;

  return (
    <Touchable
      square
      visualSize={visual}
      /**
       * `aria-*` alongside `accessibilityState`, not instead of it.
       *
       * React Native has supported the `aria-*` props on both platforms since 0.71, and
       * React Native Web does **not** reliably project `accessibilityState` onto the DOM —
       * a checkbox rendered with `accessibilityState` alone announces no checked state on
       * web at all. Found by this component's own test, which is why the assertion is on
       * `aria-checked` rather than on a prop being passed.
       */
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      aria-label={label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange?.(!checked)}
      testID={testID}
      style={{ alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: visual,
          height: visual,
          borderRadius: theme.radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: checked ? theme.colors.success : 'transparent',
          borderWidth: checked ? 0 : 1.5,
          borderColor: disabled ? theme.colors.textDisabled : theme.colors.borderStrong,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {checked ? <Check size={16} color={theme.colors.textInverse} /> : null}
      </View>
    </Touchable>
  );
}
