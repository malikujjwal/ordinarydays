import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTheme } from '../theme/index';
import type { TypeVariant } from '../theme/tokens';
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
  /** Connects an iOS keyboard toolbar to inputs such as the number pad, which has no Return. */
  inputAccessoryViewID?: string;
  maxLength?: number;
  disabled?: boolean;
  onBlur?: () => void;
  /**
   * Keeps `label` as the accessible name but does not draw it.
   *
   * For a field that already sits under a `SectionHeader` saying the same word — the detail
   * screen's `NOTES` section — where drawing it renders "NOTES" above "Notes". The label is
   * never simply dropped: an input with no accessible name is invisible to a screen reader,
   * so this hides the pixels and keeps the name.
   */
  hideLabel?: boolean;
  /**
   * `boxed` is the form control: a `surfaceRaised` fill and a radius. `bare` has neither, for
   * text that is **content rather than input** — an inline-editable screen title, which
   * `plans-and-lists.md` §2.1 renders as the header and not as a labelled form row. It still
   * focuses, still commits on blur, and still shows its focus ring. A bare multiline field
   * starts at one control row and grows with content instead of reserving a form-sized block.
   */
  appearance?: 'boxed' | 'bare';
  /** The type variant for the value. `body` unless the field *is* the screen's title. */
  textVariant?: TypeVariant;
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
  inputAccessoryViewID,
  maxLength,
  disabled = false,
  onBlur,
  hideLabel = false,
  appearance = 'boxed',
  textVariant = 'body',
  testID,
}: FieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const bare = appearance === 'bare';

  return (
    <View style={{ gap: theme.space[2] }}>
      {hideLabel ? null : (
        <Text variant="footnoteStrong" color="textSecondary">
          {required ? `${label} *` : label}
        </Text>
      )}

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
        /* A placeholder is readable tertiary content, not a disabled state (§5.1). */
        placeholderTextColor={theme.colors.textMuted}
        multiline={multiline}
        keyboardType={keyboardType}
        {...(inputAccessoryViewID === undefined ? {} : { inputAccessoryViewID })}
        {...(maxLength === undefined ? {} : { maxLength })}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        testID={testID}
        style={[
          theme.font(textVariant),
          {
            color: disabled
              ? theme.colors.textDisabled
              : bare
                ? theme.colors.textDisplay
                : theme.colors.textPrimary,
            backgroundColor: bare ? 'transparent' : theme.colors.surfaceInput,
            borderRadius: bare ? theme.radius.none : theme.radius.lg,
            paddingHorizontal: bare ? theme.space[0] : theme.space[5],
            paddingVertical: bare ? theme.space[2] : theme.space[4],
            minHeight: multiline && !bare ? 96 : theme.layout.hitTarget,
            textAlignVertical: multiline ? 'top' : 'center',
            borderWidth: 1,
            /**
             * **The rest border is `borderStrong`** — amended 2026-08-16 (P2-43), on the
             * founder's report that in light mode you cannot tell where the input is.
             *
             * It was `'transparent'`, which left the `surfaceInput` fill as the field's only
             * boundary — and that fill is **1.02:1 against `surface`** in light and 1.05:1 in
             * dark. So a text input had no perceivable edge in either scheme, which is WCAG
             * 1.4.11's 3:1 control-boundary requirement missed outright rather than narrowly.
             *
             * `design-system.md` §5.1 already answers it: `borderSubtle` "may never be the sole
             * required control indicator" and required boundaries take `borderStrong`. This is
             * that rule applied, not a new one — 4.77:1 light, 6.33:1 dark. A `bare` field is
             * exempt: it is inline text on a detail screen, not a boxed control.
             */
            borderColor:
              error !== undefined
                ? theme.colors.danger
                : focused
                  ? theme.colors.focusRing
                  : bare
                    ? 'transparent'
                    : theme.colors.borderStrong,
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
