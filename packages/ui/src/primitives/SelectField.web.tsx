import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/index';
import type { SelectFieldProps } from './SelectField.types';
import { Text } from './Text';

export type { SelectFieldProps, SelectOption } from './SelectField.types';

/** Web select surface: the platform control, restyled to match the quiet boxed fields. */
export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  error,
  hint,
  testID,
}: SelectFieldProps<Value>) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const bodyFont = theme.font('body');

  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>
      <select
        aria-label={label}
        aria-invalid={error === undefined ? undefined : true}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value as Value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        data-testid={testID}
        style={{
          ...bodyFont,
          // CSS treats a numeric line-height as a multiplier; the RN token is pixels.
          lineHeight: `${bodyFont.lineHeight}px`,
          appearance: 'none',
          width: '100%',
          minHeight: theme.layout.hitTarget,
          color: disabled ? theme.colors.textDisabled : theme.colors.textPrimary,
          backgroundColor: theme.colors.surfaceRaised,
          borderStyle: 'solid',
          borderWidth: focused ? theme.layout.focusRingWidth : 1,
          borderColor:
            error !== undefined
              ? theme.colors.danger
              : focused
                ? theme.colors.focusRing
                : theme.colors.border,
          borderRadius: theme.radius.lg,
          paddingBlock: theme.space[4],
          paddingInlineStart: theme.space[5],
          paddingInlineEnd: theme.space[10],
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.45 : 1,
          backgroundImage:
            `linear-gradient(45deg, transparent 50%, ${theme.colors.textSecondary} 50%), ` +
            `linear-gradient(135deg, ${theme.colors.textSecondary} 50%, transparent 50%)`,
          backgroundPosition: `calc(100% - ${theme.space[6]}px) 50%, calc(100% - ${theme.space[5]}px) 50%`,
          backgroundSize: `${theme.space[2]}px ${theme.space[2]}px, ${theme.space[2]}px ${theme.space[2]}px`,
          backgroundRepeat: 'no-repeat',
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>

      {error === undefined ? (
        hint === undefined ? null : (
          <Text variant="footnote" color="textSecondary">
            {hint}
          </Text>
        )
      ) : (
        <Text variant="footnote" color="danger" accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}
