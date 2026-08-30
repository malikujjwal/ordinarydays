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
  /** Draws `Optional` opposite the visible label; placeholder text never carries optionality. */
  optional?: boolean;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'number-pad' | 'url';
  /** Connects an iOS keyboard toolbar to inputs such as the number pad, which has no Return. */
  inputAccessoryViewID?: string;
  maxLength?: number;
  disabled?: boolean;
  onBlur?: () => void;
  /**
   * Overrides the accessible name while `label` keeps drawing the visible one.
   *
   * Added for `plans-and-lists.md` §5.4 rule 6, which requires the list-name field to announce
   * `List name, pre-filled with Movies to watch` — the label plus what is already in the box —
   * while the form still shows the two words a sighted user reads. Every other primitive in
   * this package already separates the two; this was the outlier, and the alternative was a
   * screen re-drawing the label itself with `hideLabel`, which duplicates a style decision
   * that belongs here.
   *
   * It never replaces the label with something unrelated: the visible words must remain a
   * prefix of what is spoken, or the two audiences are being told different things.
   */
  accessibilityLabel?: string;
  /**
   * Return commits, for a field that is a **rapid-entry row** rather than part of a form.
   *
   * `plans-and-lists.md` §5.6's inline add row is the case: Return activates the write and the
   * field stays focused so the next item can be typed straight away. Supplying this sets the
   * return key to `done` and, unless `submitBlurs`, keeps the keyboard up — a row that
   * dismissed itself would make a shopping list several taps longer than it needs to be.
   */
  onSubmitEditing?: () => void;
  /** Let Return dismiss the keyboard after committing. Off, because rapid entry is the point. */
  submitBlurs?: boolean;
  /**
   * Focuses the input on mount, for a step whose whole purpose is typing into it.
   *
   * Used where the field is the step — the title step of the list creation sheet opens with
   * the name selected and the keyboard up. Not for a field that merely happens to be first on
   * a longer form, where stealing focus scrolls the screen out from under the reader.
   */
  autoFocus?: boolean;
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
   * `underline` is the rapid-entry control: content-like at rest, with one persistent boundary
   * that becomes the focus indicator instead of drawing a form box around the row.
   */
  appearance?: 'boxed' | 'bare' | 'underline';
  /** The type variant for the value. `body` unless the field *is* the screen's title. */
  textVariant?: TypeVariant;
  testID?: string;
}

export function Field({
  label,
  accessibilityLabel,
  autoFocus = false,
  onSubmitEditing,
  submitBlurs = false,
  value,
  onChangeText,
  placeholder,
  error,
  hint,
  required = false,
  optional = false,
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
  const underline = appearance === 'underline';
  const quiet = bare || underline;

  return (
    <View style={{ gap: theme.space[2] }}>
      {hideLabel ? null : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
          }}
        >
          <Text variant="footnoteStrong" color="textSecondary">
            {required ? `${label} *` : label}
          </Text>
          {optional ? (
            <Text variant="footnote" color="textSecondary">
              Optional
            </Text>
          ) : null}
        </View>
      )}

      <TextInput
        accessibilityLabel={accessibilityLabel ?? label}
        aria-label={accessibilityLabel ?? label}
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
        autoFocus={autoFocus}
        {...(onSubmitEditing === undefined
          ? {}
          : {
              onSubmitEditing,
              returnKeyType: 'done' as const,
              blurOnSubmit: submitBlurs,
            })}
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
              : quiet
                ? theme.colors.textDisplay
                : theme.colors.textPrimary,
            backgroundColor: quiet ? 'transparent' : theme.colors.surfaceInput,
            borderRadius: quiet ? theme.radius.none : theme.radius.lg,
            paddingHorizontal: quiet ? theme.space[0] : theme.space[5],
            paddingVertical: quiet ? theme.space[2] : theme.space[4],
            minHeight: multiline && !quiet ? 96 : theme.layout.hitTarget,
            textAlignVertical: multiline ? 'top' : 'center',
            outlineColor: underline ? 'transparent' : undefined,
            outlineStyle: underline ? 'solid' : undefined,
            outlineWidth: underline ? 0 : undefined,
            ...(underline
              ? {
                  borderWidth: 0,
                  borderBottomWidth: focused ? theme.layout.focusRingWidth : 1,
                }
              : { borderWidth: 1 }),
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
            borderBottomColor: underline
              ? focused
                ? theme.colors.focusRing
                : theme.colors.borderStrong
              : undefined,
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
