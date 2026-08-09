import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTheme } from '../theme/index';
import { Text } from './Text';

/**
 * A labelled text input (`design-system.md` §6).
 *
 * `surfaceRaised` fill, `radius.lg`, and **no visible border until focus** — the mock's
 * fields are quiet rectangles, not boxed forms.
 *
 * Validation errors are inline and per-field, shown on blur and again on save, and map
 * one-to-one onto the `details[]` entries of a `validation_failed` response
 * (`activities.md` §3 rule 5). An error never blocks the save button — it highlights.
 */
export interface FieldProps {
  label: string;
  value: string;
  onChangeText?: (next: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad' | 'url';
  maxLength?: number;
  disabled?: boolean;
  onBlur?: () => void;
  testID?: string;
}

export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  required = false,
  multiline = false,
  keyboardType = 'default',
  maxLength,
  disabled = false,
  onBlur,
  testID,
}: FieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="footnoteStrong" color="textSecondary">
        {required ? `${label} *` : label}
      </Text>

      <TextInput
        accessibilityLabel={label}
        aria-label={label}
        accessibilityState={{ disabled }}
        aria-disabled={disabled}
        /**
         * **The error is announced, not only reddened.** Colour is never the only carrier of
         * meaning (`design-system.md` §5.1), and `accessibilityHint` alone does not reach
         * the DOM through React Native Web — `aria-errormessage` needs an element to point
         * at, so the text is inlined as the description instead.
         */
        {...(error === undefined
          ? {}
          : {
              accessibilityHint: error,
              'aria-description': error,
              'aria-invalid': true,
            })}
        editable={!disabled}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textDisabled}
        multiline={multiline}
        keyboardType={keyboardType}
        {...(maxLength === undefined ? {} : { maxLength })}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        testID={testID}
        style={[
          theme.font('body'),
          {
            color: disabled ? theme.colors.textDisabled : theme.colors.textPrimary,
            backgroundColor: theme.colors.surfaceRaised,
            borderRadius: theme.radius.lg,
            paddingHorizontal: theme.space[5],
            paddingVertical: theme.space[4],
            minHeight: multiline ? 96 : theme.layout.hitTarget,
            textAlignVertical: multiline ? 'top' : 'center',
            borderWidth: 1,
            borderColor:
              error !== undefined
                ? theme.colors.danger
                : focused
                  ? theme.colors.focusRing
                  : 'transparent',
          },
        ]}
      />

      {error === undefined ? (
        hint === undefined ? null : (
          <Text variant="footnote" color="textSecondary">
            {hint}
          </Text>
        )
      ) : (
        <Text variant="footnote" color="danger">
          {error}
        </Text>
      )}
    </View>
  );
}
