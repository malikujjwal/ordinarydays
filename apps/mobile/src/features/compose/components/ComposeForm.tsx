import type { CreationTarget } from '@od/shared/client';
import { MAX_TITLE_LEN } from '@od/shared/constants';
import { Button, Field, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import {
  type CommonDraftFields,
  saveLabel,
  targetHeading,
} from '@/features/compose/model/targets';

/**
 * The creation form for a target that has already been fixed (P1-24).
 *
 * **P1-25 replaces the middle of this component**, not its edges. The header, the capture
 * row, the error banner and the named write button are the parts P1-24 owns and are the same
 * on all five forms; what changes per type is the field list, which `activities.md` §4
 * specifies exactly and which arrives as a typed form renderer.
 *
 * ## The header is not a banner
 *
 * `Task` / `Plan · Watch` stays visible while the form is filled and is not dismissible
 * (`activities.md` §2.4). `Change` returns to the chooser that produced it. Capture cannot
 * invoke that action — it is a prop this component receives from the screen, and the capture
 * callbacks below reach only `title`, `notes` and `sourceUrl`.
 *
 * ## The write lives below, not here (P2-43)
 *
 * `Save task` / `Save plan` moved out of the scrolling body and into {@link ComposeSaveBar},
 * which the screen hands to `ScreenShell`'s footer slot. A named write that scrolls away is a
 * named write the user has to go looking for, and on a long Event form it was three screens
 * below the title. The two components ship together so the label and what disables it stay one
 * decision.
 */
export interface ComposeFormProps {
  target: CreationTarget;
  fields: CommonDraftFields;
  /** `activities.md` §4's table for this target, rendered in order (P1-25). */
  typedFields: React.ReactNode;
  onTitleChange: (title: string) => void;
  onChangeTarget: () => void;
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  fieldErrors: Record<string, string>;
}

/**
 * Phase 1 has no attachment upload (`POST /v1/attachments/upload-url` is Phase 3), so a
 * picked photo cannot be part of a save. The image stays, the save waits — the alternative,
 * saving and silently dropping the photo, is the one behaviour that would lose user content.
 */
const SAVE_BLOCKED_BY_PHOTO = 'Remove the photo to save this.';

export function ComposeForm({
  target,
  fields,
  typedFields,
  onTitleChange,
  onChangeTarget,
  errorMessage,
  errorRequestId,
  fieldErrors,
}: ComposeFormProps) {
  const theme = useTheme();

  return (
    <View testID="compose-form" style={{ gap: theme.space[6] }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.space[4],
        }}
      >
        <Text
          variant="caption"
          color="textSecondary"
          accessibilityRole="header"
          testID="compose-target-heading"
        >
          {targetHeading(target)}
        </Text>
        <Button
          label="Change"
          variant="ghost"
          onPress={onChangeTarget}
          testID="compose-change-target"
        />
      </View>

      <Field
        label="Title"
        value={fields.title}
        onChangeText={onTitleChange}
        required
        maxLength={MAX_TITLE_LEN}
        testID="compose-title"
        {...(fieldErrors.title === undefined ? {} : { error: fieldErrors.title })}
      />

      {/**
       * P1-25's type-specific fields, in `activities.md` §4's order — **including `Notes`**,
       * which is the last row of all five tables and so belongs to the table rather than to
       * this frame. A slot, so the ordering lives in one renderer over the five tables
       * (`forms/TypedFields.tsx`) instead of being restated here and drifting.
       */}
      {typedFields}

      {/**
       * §5.3's mutation-failure presentation: the form stays open with its draft intact and
       * an inline banner. The request id is rendered in small text beside it so a support
       * message can name it.
       */}
      {errorMessage === undefined ? null : (
        <View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          testID="compose-error"
          style={{
            gap: theme.space[2],
            padding: theme.space[5],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surfaceSunken,
          }}
        >
          <Text variant="subhead" color="danger">
            {errorMessage}
          </Text>
          {errorRequestId === undefined ? null : (
            <Text variant="footnote" color="textSecondary" selectable>
              {errorRequestId}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export interface ComposeSaveBarProps {
  target: CreationTarget;
  /** Whether the named write is available. `title` alone; see `canSave`. */
  saveEnabled: boolean;
  attachmentUri: string | undefined;
  onSave: () => void;
  isSaving: boolean;
}

/**
 * The pinned named write (P2-43).
 *
 * Full width, above the safe area, and **it names the exact write and destination** —
 * `CLAUDE.md` rule 2, unchanged from P1-24 and deliberately re-verified rather than restated:
 * the label still comes from `saveLabel(target)`, which reads the explicit choice and nothing
 * about the words typed above it.
 *
 * `ScreenShell` decides where this sits, how clear of the home indicator it is, and what the
 * keyboard does to it. This component decides only what the button says.
 */
export function ComposeSaveBar({
  target,
  saveEnabled,
  attachmentUri,
  onSave,
  isSaving,
}: ComposeSaveBarProps) {
  const theme = useTheme();
  const blockedByPhoto = attachmentUri !== undefined;

  return (
    <View style={{ gap: theme.space[3] }}>
      <Button
        label={saveLabel(target)}
        size="lg"
        fullWidth
        onPress={onSave}
        loading={isSaving}
        disabled={!saveEnabled || blockedByPhoto}
        testID="compose-save"
      />
      {blockedByPhoto ? (
        <Text variant="footnote" color="textSecondary" align="center">
          {SAVE_BLOCKED_BY_PHOTO}
        </Text>
      ) : null}
    </View>
  );
}
