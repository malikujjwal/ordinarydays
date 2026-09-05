import { type Ref, useState } from 'react';
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/index';

/**
 * The pressable every interactive primitive is built on.
 *
 * It exists so that three accessibility guarantees are structural rather than remembered
 * (`design-system.md` §9):
 *
 * - **A 44 × 44 minimum hit target, unconditionally**, whatever the visual size. Applied as
 *   `minWidth`/`minHeight` plus `hitSlop` where the visual is smaller.
 * - **A focus ring that is always visible and at least 2 px**, and that **no prop can
 *   remove**. There is deliberately no `focusRing={false}`.
 * - **Press feedback capped at `fast`** — the opacity change, not a scale that fights the
 *   finger.
 *
 * A component that reached for `Pressable` directly would be a component that can get any of
 * the three wrong, which is why nothing in `primitives/` does.
 */

export interface TouchableProps extends Omit<PressableProps, 'style' | 'children'> {
  elementRef?: Ref<View>;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** React Native Web forwards these as `data-*`; native safely ignores them. */
  dataSet?: Record<string, string>;
  /** Visual size below 44; the difference is made up with `hitSlop`. */
  visualSize?: number;
  /** Set `false` for a full-width or row-shaped target that should not be forced square. */
  square?: boolean;
}

export function Touchable({
  children,
  elementRef,
  style,
  visualSize,
  square = false,
  disabled,
  onFocus,
  onBlur,
  ...rest
}: TouchableProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  const target = theme.layout.hitTarget;
  const slop =
    visualSize !== undefined && visualSize < target
      ? Math.ceil((target - visualSize) / 2)
      : 0;

  return (
    <Pressable
      ref={elementRef}
      accessibilityState={{ disabled: disabled === true }}
      disabled={disabled}
      hitSlop={slop}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      style={({ pressed }) => [
        {
          minHeight: target,
          ...(square ? { minWidth: target } : {}),
          justifyContent: 'center',
        },
        // Feedback is opacity only, at `fast`. A scale transform on a row fights the finger.
        pressed && !(disabled === true) ? { opacity: 0.7 } : null,
        focused
          ? {
              outlineStyle: 'solid',
              outlineWidth: theme.layout.focusRingWidth,
              outlineColor: theme.colors.focusRing,
              outlineOffset: 2,
            }
          : null,
        style,
      ]}
      {...rest}
    >
      {children}
    </Pressable>
  );
}
