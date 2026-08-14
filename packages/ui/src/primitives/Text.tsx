import { Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from '../theme/index';
import type { TypeVariant } from '../theme/tokens';

/**
 * Every piece of text in the product (`design-system.md` §3).
 *
 * There are exactly nine variants and a tenth is a decision, not a preference. `allowFontScaling`
 * is never `false` — it is not even a prop here, because the one way to get dynamic type wrong
 * is to be given the option to switch it off (`interaction-contract.md` §6.3).
 */

export type TextColor =
  | 'textDisplay'
  | 'textPrimary'
  | 'textSecondary'
  /** Readable tertiary content — hints, placeholders, metadata. Never a disabled state. */
  | 'textMuted'
  | 'textDisabled'
  | 'textAction'
  | 'accent'
  | 'danger'
  | 'success'
  | 'warning'
  | 'inverse';

export interface TextProps extends Omit<RNTextProps, 'style' | 'allowFontScaling'> {
  variant?: TypeVariant;
  color?: TextColor;
  align?: 'left' | 'center' | 'right';
  /**
   * Struck through — a completed row's title. Colour is never the only carrier of meaning
   * (§5.1), so completion is a check **and** a strike **and** a dimmed row, not just olive.
   */
  struck?: boolean;
  /** Uppercase is applied by the `caption` variant automatically; this is not a prop. */
  children: React.ReactNode;
}

export function Text({
  variant = 'body',
  color = 'textPrimary',
  align,
  struck = false,
  numberOfLines,
  children,
  ...rest
}: TextProps) {
  const theme = useTheme();
  const font = theme.font(variant);
  const resolved = color === 'inverse' ? theme.colors.textInverse : theme.colors[color];

  return (
    <RNText
      // Never `false`. Dynamic type is not optional.
      allowFontScaling
      /**
       * Rows default to two lines: `design-system.md` §9 says titles wrap to two before
       * truncating and never truncate at one line at the default size.
       */
      numberOfLines={numberOfLines ?? (variant === 'body' ? 2 : undefined)}
      style={[
        font,
        { color: resolved },
        variant === 'caption' ? { textTransform: 'uppercase' } : null,
        struck ? { textDecorationLine: 'line-through' } : null,
        align === undefined ? null : { textAlign: align },
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
