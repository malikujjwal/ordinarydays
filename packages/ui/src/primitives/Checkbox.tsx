import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { Check } from '../icons/index';
import { useMotion, useTheme } from '../theme/index';
import { Touchable } from './Touchable';

/**
 * The one control that mutates from a row (`design-system.md` §6,
 * `interaction-contract.md` U1).
 *
 * 44 × 44 target, 20 × 20 visual. Checked is an **olive** fill with a white check — the
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
  const motion = useMotion();
  const visual = 20;
  const previousChecked = useRef(checked);
  const scale = useRef(new Animated.Value(1)).current;
  const checkProgress = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    const changed = previousChecked.current !== checked;
    previousChecked.current = checked;
    const finalProgress = checked ? 1 : 0;
    if (!changed || motion.duration.fast === 0) {
      scale.setValue(1);
      checkProgress.setValue(finalProgress);
      return;
    }

    scale.setValue(0.88);
    const transition = Animated.parallel([
      Animated.timing(scale, {
        toValue: 1,
        duration: motion.duration.fast,
        useNativeDriver: true,
      }),
      Animated.timing(checkProgress, {
        toValue: finalProgress,
        duration: motion.duration.fast,
        useNativeDriver: true,
      }),
    ]);
    transition.start();
    return () => transition.stop();
  }, [checkProgress, checked, motion.duration.fast, scale]);

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
      <Animated.View
        testID={testID === undefined ? undefined : `${testID}-visual`}
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
          transform: [{ scale }],
        }}
      >
        <Animated.View
          aria-hidden
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            opacity: checkProgress,
            transform: [
              {
                scale: checkProgress.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.7, 1],
                }),
              },
            ],
          }}
        >
          <Check size={14} color={theme.colors.textInverse} />
        </Animated.View>
      </Animated.View>
    </Touchable>
  );
}
