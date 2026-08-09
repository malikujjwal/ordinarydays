import type { CreationTarget } from '@od/shared/client';
import { MAX_TITLE_LEN } from '@od/shared/constants';
import { Button, Field, Text, useTheme } from '@od/ui';
import { View } from 'react-native';
import { CaptureRow } from '@/features/compose/components/CaptureRow';
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
 * on all six forms; what changes per type is the field list, which `activities.md` §4
 * specifies exactly and which arrives as `{Task,Meal,Watch,Event,Outing,Custom}Form`. Phase 1
 * renders the two fields common to every one of those tables — title and notes — so the flow
 * is complete end to end before the tables land.
 *
 * ## The header is not a banner
 *
 * `Task` / `Plan · Watch` stays visible while the form is filled and is not dismissible
 * (`activities.md` §2.4). `Change` returns to the chooser that produced it. Capture cannot
 * invoke that action — it is a prop this component receives from the screen, and the capture
 * callbacks below reach only `title`, `notes` and `sourceUrl`.
 */
export interface ComposeFormProps {
  target: CreationTarget;
  fields: CommonDraftFields;
  /** `activities.md` §4's table for this target, rendered in order (P1-25). */
  typedFields: React.ReactNode;
  /** Whether the named write is available. `title` alone in Phase 1; see `canSave`. */
  saveEnabled: boolean;
  attachmentUri: string | undefined;
  onTitleChange: (title: string) => void;
  onSourceUrlChange: (url: string) => void;
  onAttach: (uri: string) => void;
  onClearAttachment: () => void;
  onChangeTarget: () => void;
  onSave: () => void;
  isSaving: boolean;
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
  saveEnabled,
  attachmentUri,
  onTitleChange,
  onSourceUrlChange,
  onAttach,
  onClearAttachment,
  onChangeTarget,
  onSave,
  isSaving,
  errorMessage,
  errorRequestId,
  fieldErrors,
}: ComposeFormProps) {
  const theme = useTheme();
  const blockedByPhoto = attachmentUri !== undefined;

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
       * which is the last row of all six tables and so belongs to the table rather than to
       * this frame. A slot, so the ordering lives in one renderer over the six tables
       * (`forms/TypedFields.tsx`) instead of being restated here and drifting.
       */}
      {typedFields}

      <CaptureRow
        sourceUrl={fields.sourceUrl}
        onSourceUrlChange={onSourceUrlChange}
        attachmentUri={attachmentUri}
        onAttach={onAttach}
        onClearAttachment={onClearAttachment}
      />

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
    </View>
  );
}
