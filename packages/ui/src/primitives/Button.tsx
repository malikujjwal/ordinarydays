import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { IconProps } from '../icons/index';
import { useTheme } from '../theme/index';
import type { RadiusToken } from '../theme/tokens';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * `design-system.md` §6.
 *
 * `primary` is the accent fill — the one control in the
 * product that gets it, which is what makes the single primary action on a screen read as the
 * single primary action.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost';

export interface ButtonProps {
  label: string;
  /** Override when the visible shorthand does not describe the action's result. */
  accessibilityLabel?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /**
   * `md` 44 · `lg` 52 · **`sm`** — added 2026-08-16 (P2-44).
   *
   * `sm` is the quick-action text button `design-system.md` §7.1 draws on the UP NEXT card:
   * `footnoteStrong`, no icon, no chrome. Its **visual** height is 32 and its **hit target**
   * stays 44 through `Touchable`'s `hitSlop`, so §2's minimum holds while three actions still
   * fit across a 390 pt card. It is a size, not a new component: §0's component-family rule is
   * that a text action is `Button`'s ghost role, and a second component for a smaller one is
   * exactly the sprawl that rule exists to prevent.
   */
  size?: 'sm' | 'md' | 'lg';
  icon?: (props: IconProps) => React.ReactElement;
  /**
   * Which side the icon sits on. `leading` is the default and is right for almost everything —
   * the icon prefigures the label.
   *
   * `trailing` exists for a control whose icon reports **state rather than kind**: EARLIER
   * TODAY's `2 done ⌃`, where the chevron says which way the section will move and therefore
   * belongs after the thing it is describing (`design-system.md` §7.1 draws it that way).
   */
  iconPosition?: 'leading' | 'trailing';
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  /**
   * `md` — the filled-control shape. **Not `pill`**, which the radius table reserves for things
   * that behave like pills: the Add button, chips, filters. Defaulting to `pill` made every
   * button a lozenge, which is the shape a control takes when nothing decided it should.
   */
  radius?: RadiusToken;
  /**
   * **A text action whose label lines up with the text column** — added 2026-08-16 (P2-43).
   *
   * A `ghost` button has no fill, so its horizontal padding is invisible ink that pushes the
   * label 20 pt in from whatever column it sits in. On the Add screen that put `Back` and
   * `Change` out of line with the `Title` beneath them, which the founder reported as the
   * buttons "not being inline".
   *
   * `flush` pulls the box outward by exactly that padding, so the **label** aligns and the
   * padding becomes hit target extending into the gutter rather than an indent. Removing the
   * padding instead would have taken a short label like `Back` below the 44 pt minimum
   * (`interaction-contract.md` §2), which is the trade this shape avoids.
   */
  flush?: boolean;
  testID?: string;
}

export function Button({
  label,
  accessibilityLabel,
  onPress,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  iconPosition = 'leading',
  loading = false,
  disabled = false,
  fullWidth = false,
  radius = 'md',
  flush = false,
  testID,
}: ButtonProps) {
  const theme = useTheme();

  /**
   * The spinner appears only after 400 ms. A button that flashes a spinner for one frame on
   * a fast response reads as a glitch, not as progress.
   */
  const [showSpinner, setShowSpinner] = useState(false);
  useEffect(() => {
    if (!loading) {
      setShowSpinner(false);
      return;
    }
    const timer = setTimeout(() => setShowSpinner(true), 400);
    return () => clearTimeout(timer);
  }, [loading]);

  const inactive = disabled || loading;
  const height = size === 'lg' ? 52 : size === 'sm' ? 32 : theme.layout.hitTarget;

  const palette = {
    // `accentControl`, not `accent`: the dark `accent` carries an inverse label at only
    // 4.00:1. The palette resolves which fill each scheme uses so this stays branch-free.
    primary: {
      bg: theme.colors.accentControl,
      fg: 'inverse' as const,
      border: 'transparent',
    },
    secondary: {
      bg: theme.colors.surfaceRaised,
      fg: 'textPrimary' as const,
      border: theme.colors.border,
    },
    ghost: { bg: 'transparent', fg: 'textAction' as const, border: 'transparent' },
    danger: { bg: theme.colors.danger, fg: 'inverse' as const, border: 'transparent' },
    dangerGhost: {
      bg: 'transparent',
      fg: 'danger' as const,
      border: 'transparent',
    },
  }[variant];
  const foregroundColor =
    palette.fg === 'inverse' ? theme.colors.textInverse : theme.colors[palette.fg];

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      // Below 44 the visual shrinks and the target does not (§2).
      {...(size === 'sm' ? { visualSize: height } : {})}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={[
        {
          height,
          paddingHorizontal: size === 'sm' ? theme.space[3] : theme.space[6],
          ...(flush
            ? { marginHorizontal: -(size === 'sm' ? theme.space[3] : theme.space[6]) }
            : {}),
          borderRadius: theme.radius[radius],
          backgroundColor: palette.bg,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: palette.border,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.space[3],
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
        },
        inactive ? { opacity: 0.45 } : null,
      ]}
    >
      {showSpinner ? (
        <ActivityIndicator size="small" color={foregroundColor} />
      ) : (
        <>
          {Icon === undefined || iconPosition === 'trailing' ? null : (
            <Icon size={20} color={foregroundColor} />
          )}
          <View>
            <Text
              variant={size === 'sm' ? 'footnoteStrong' : 'bodyStrong'}
              color={palette.fg}
            >
              {label}
            </Text>
          </View>
          {Icon === undefined || iconPosition === 'leading' ? null : (
            <Icon size={20} color={foregroundColor} />
          )}
        </>
      )}
    </Touchable>
  );
}
