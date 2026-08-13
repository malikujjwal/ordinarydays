import { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../theme/index';
import type { SelectFieldProps, SelectOption } from './SelectField.types';
import { Sheet } from './Sheet';
import { Text } from './Text';
import { Touchable } from './Touchable';

export type { SelectFieldProps, SelectOption } from './SelectField.types';

/** Native select surface: a quiet collapsed field opening one accessible option sheet. */
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
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);

  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        {label}
      </Text>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? value}`}
        accessibilityHint={`Choose ${label.toLowerCase()}`}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        testID={testID}
        style={{
          minHeight: theme.layout.hitTarget,
          paddingHorizontal: theme.space[5],
          paddingVertical: theme.space[4],
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor:
            error === undefined ? theme.colors.borderSubtle : theme.colors.danger,
          backgroundColor: theme.colors.surfaceInput,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
          opacity: disabled ? 0.45 : 1,
        }}
      >
        <Text variant="body" color={disabled ? 'textDisabled' : 'textPrimary'}>
          {selected?.label ?? value}
        </Text>
        <Text variant="body" color="textSecondary" accessibilityElementsHidden>
          v
        </Text>
      </Touchable>

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

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={label}
        testID={`${testID}-menu`}
      >
        <View style={{ gap: theme.space[3] }}>
          {options.map((option: SelectOption<Value>) => {
            const active = option.value === value;
            return (
              <Touchable
                key={option.value}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{ selected: active }}
                onPress={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                style={{
                  minHeight: theme.layout.hitTarget,
                  paddingHorizontal: theme.space[5],
                  paddingVertical: theme.space[4],
                  borderRadius: theme.radius.md,
                  backgroundColor: active
                    ? theme.colors.accentSurface
                    : theme.colors.surfaceRaised,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.space[4],
                }}
              >
                <Text variant="body" color="textPrimary">
                  {option.label}
                </Text>
                {active ? (
                  <Text variant="bodyStrong" color="accent">
                    Selected
                  </Text>
                ) : null}
              </Touchable>
            );
          })}
        </View>
      </Sheet>
    </View>
  );
}
