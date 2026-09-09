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
  /** §4's own name for the title row — `Meal`, `Movie or show`, `Title`. */
  titleLabel: string;
  onTitleChange: (title: string) => void;
  onChangeTarget: () => void;
  /** Global Add already shows the title above the category choices. */
  hideTitle?: boolean;
  /** Global Add keeps the category choices visible, so Change is redundant. */
  hideChange?: boolean;
  errorMessage: string | undefined;
  errorRequestId: string | undefined;
  fieldErrors: Record<string, string>;
}

/**
 * A photo still uploading, or one that failed, holds the save (P3-41). The alternative —
 * saving and silently dropping the photo — is the one behaviour that would lose user
 * content. The row itself carries `Retry` and `Remove`; this line only says why the button
 * waits.
 */
const SAVE_WAITS_FOR_UPLOAD = 'Waiting for the photo to finish uploading.';
const SAVE_BLOCKED_BY_FAILED_UPLOAD = 'Retry or remove the photo to save this.';

export function ComposeForm({
  target,
  fields,
  typedFields,
  titleLabel,
  onTitleChange,
  onChangeTarget,
  hideTitle = false,
  hideChange = false,
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
        {hideChange ? null : (
          <Button
            label="Change"
            variant="ghost"
            flush
            onPress={onChangeTarget}
            testID="compose-change-target"
          />
        )}
      </View>

      {hideTitle ? null : (
        <Field
          label={titleLabel}
          value={fields.title}
          onChangeText={onTitleChange}
          required
          maxLength={MAX_TITLE_LEN}
          testID="compose-title"
          {...(fieldErrors.title === undefined ? {} : { error: fieldErrors.title })}
        />
      )}

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
  target?: CreationTarget;
  /** Overrides `saveLabel(target)` for global Create task / Create plan / Create list. */
  label?: string;
  /**
   * The destination a List item is bound for, so the button can name it (criterion 33).
   *
   * Absent for Task and Plan, whose labels are fixed, and absent for an item whose list name
   * has not resolved yet — `saveLabel` then reads `Add to list`, which is what the form shows
   * while the name loads and never a destination it chose.
   */
  listName?: string;
  /** Whether the named write is available. `title` alone; see `canSave`. */
  saveEnabled: boolean;
  /** The picker's state: `busy` while a photo moves, `failed` while one needs attention. */
  attachments: { busy: boolean; failed: boolean };
  /** P3-43: the combined write's own name — `Save plan and add 3 items to Groceries`. */
  bridgeLabel?: string;
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
  label,
  listName,
  saveEnabled,
  attachments,
  bridgeLabel,
  onSave,
  isSaving,
}: ComposeSaveBarProps) {
  const theme = useTheme();
  const blockedByPhoto = attachments.busy || attachments.failed;

  return (
    <View style={{ gap: theme.space[3] }}>
      <Button
        label={
          bridgeLabel ??
          label ??
          (target === undefined ? 'Choose a category' : saveLabel(target, listName))
        }
        size="lg"
        fullWidth
        onPress={onSave}
        loading={isSaving}
        disabled={!saveEnabled || blockedByPhoto}
        testID="compose-save"
      />
      {blockedByPhoto ? (
        <Text variant="footnote" color="textSecondary" align="center">
          {attachments.busy ? SAVE_WAITS_FOR_UPLOAD : SAVE_BLOCKED_BY_FAILED_UPLOAD}
        </Text>
      ) : null}
    </View>
  );
}
