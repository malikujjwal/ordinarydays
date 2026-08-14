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

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  /** Override when the visible shorthand does not describe the action's result. */
  accessibilityLabel?: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'md' | 'lg';
  icon?: (props: IconProps) => React.ReactElement;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  /**
   * `md` — the filled-control shape. **Not `pill`**, which the radius table reserves for things
   * that behave like pills: the Add button, chips, filters. Defaulting to `pill` made every
   * button a lozenge, which is the shape a control takes when nothing decided it should.
   */
  radius?: RadiusToken;
  testID?: string;
}

export function Button({
  label,
  accessibilityLabel,
  onPress,
  variant = 'primary',
  size = 'md',
  icon: Icon,
  loading = false,
  disabled = false,
  fullWidth = false,
  radius = 'md',
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
  }[variant];
  const foregroundColor =
    palette.fg === 'inverse' ? theme.colors.textInverse : theme.colors[palette.fg];

  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={[
        {
          height: size === 'lg' ? 52 : theme.layout.hitTarget,
          paddingHorizontal: theme.space[6],
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
          {Icon === undefined ? null : <Icon size={20} color={foregroundColor} />}
          <View>
            <Text variant="bodyStrong" color={palette.fg}>
              {label}
            </Text>
          </View>
        </>
      )}
    </Touchable>
  );
}
