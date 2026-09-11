import { Field, Text, Touchable, useTheme } from '@od/ui';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { SectionFrame } from '@/features/activity/components/SectionFrame';
import type { useNotesDraft } from '../hooks/useNotesDraft';

export type NotesDraft = ReturnType<typeof useNotesDraft>;

/**
 * Notes on Activity detail, after the content sections (founder, 2026-09-10).
 *
 * - **Empty:** one compact line — muted `No notes` left, `Add notes` right — rather than a
 *   `Notes` heading over `No notes yet.`
 * - **With text:** the `Notes` caption heading with `Edit` in the trailing slot, then the
 *   two-line preview. The heading is **not** ruled (founder, 2026-09-11) — unlike Details,
 *   Ingredients and Settings — so the preview sits `SectionFrame`'s ordinary caption-to-content
 *   gap below it and closes on its own rule.
 * - **Editing:** the approved inline editor, unchanged — explicit Save/Cancel in the footer,
 *   the draft kept on a failed save, `Private to you.` on a shared plan.
 */
export function ActivityNotes({
  notes,
  value,
  kind,
  pending,
  privacyNote,
}: {
  notes: NotesDraft;
  value: string;
  kind: 'task' | 'plan';
  pending: boolean;
  /** Shared activities only — privately there is nobody to distinguish from. */
  privacyNote?: string;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const wasSaving = useRef(false);
  useEffect(() => {
    if (!notes.editing && !notes.confirming) {
      const frame = requestAnimationFrame(notes.focusAction);
      return () => cancelAnimationFrame(frame);
    }
  }, [notes.editing, notes.confirming, notes.focusAction]);
  useEffect(() => {
    if (wasSaving.current && !notes.saving) {
      if (notes.error) notes.inputRef.current?.focus();
      else AccessibilityInfo.announceForAccessibility('Notes saved.');
    }
    wasSaving.current = notes.saving;
  }, [notes.saving, notes.error, notes.inputRef]);

  const hasText = value.trim() !== '';
  const privacy =
    privacyNote === undefined ? null : (
      <Text variant="footnote" color="textSecondary" testID="notes-privacy">
        {privacyNote}
      </Text>
    );

  if (!hasText && !notes.editing) {
    return (
      <View
        testID="section-notes"
        style={{
          gap: theme.space[1],
          // The approved mock closes Notes on a hairline, like every Details row above it.
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.border,
          ...(privacy === null ? {} : { paddingBottom: theme.space[3] }),
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.space[3],
            minHeight: theme.layout.hitTarget,
          }}
        >
          <Text color="textMuted" testID="notes-preview">
            No notes
          </Text>
          {/**
           * The `SectionFrame` trailing-action treatment, not a ghost `Button`: the button's
           * own horizontal padding inset `Add notes` from the right edge every other trailing
           * value on the screen lines up on (device report, 2026-09-11).
           */}
          {pending ? null : (
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Add notes"
              onPress={notes.edit}
              elementRef={notes.actionRef}
              testID="notes-edit"
              style={{
                minHeight: theme.layout.hitTarget,
                justifyContent: 'center',
                flexShrink: 1,
              }}
            >
              <Text variant="footnoteStrong" color="textAction">
                Add notes
              </Text>
            </Touchable>
          )}
        </View>
        {privacy}
      </View>
    );
  }

  const trailing = pending
    ? {
        trailing: expanded ? 'Show less' : 'Show notes',
        onTrailingPress: () => setExpanded(!expanded),
      }
    : notes.editing
      ? {}
      : {
          trailing: 'Edit',
          trailingAccessibilityLabel: 'Edit notes',
          onTrailingPress: notes.edit,
          trailingRef: notes.actionRef,
          trailingTestID: 'notes-edit',
        };

  return (
    <SectionFrame label="Notes" testID="section-notes" {...trailing}>
      <View style={{ gap: theme.space[3] }}>
        {privacy}
        {notes.editing ? (
          <Field
            inputRef={notes.inputRef}
            label={`Notes for this ${kind}`}
            value={notes.draft}
            onChangeText={notes.change}
            multiline
            autoFocus
            disabled={notes.saving}
            testID="detail-notes"
            hint="Changes are saved only when you choose Save notes."
            {...(notes.error
              ? {
                  error:
                    "Couldn't save your notes. Your draft is still here. Choose Save notes to try again.",
                }
              : {})}
          />
        ) : (
          /* The preview closes on its own rule, like a Details row; the editor has a border. */
          <View
            testID="notes-preview-rule"
            style={{
              paddingBottom: theme.space[4],
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          >
            <Text
              color="textSecondary"
              numberOfLines={pending && expanded ? 0 : 2}
              testID="notes-preview"
            >
              {value}
            </Text>
          </View>
        )}
      </View>
    </SectionFrame>
  );
}
